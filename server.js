const express = require('express');
const path = require('path');
const fs = require('fs');
const ModbusRTU = require('modbus-serial');

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(express.static(path.join(__dirname, 'public')));

// ===== CONFIGURATION =====
const CONFIG = {
  inverter: {
    ip: process.env.INVERTER_IP || '192.168.178.137',
    port: parseInt(process.env.INVERTER_PORT) || 502,
    unitId: 1
  },
  ihome: {
    ip: process.env.IHOME_IP || '192.168.178.138',
    port: parseInt(process.env.IHOME_PORT) || 502,
    unitId: 1
  },
  demoMode: process.env.DEMO_MODE === 'true'
};

// ===== SOLAR DATA =====
let solarData = {
  pv: { power: 0, daily: 0, status: 'idle' },
  battery: { power: 0, soc: 0, capacity: 9.6, status: 'idle' },
  grid: { power: 0, daily_import: 0, daily_export: 0, status: 'idle' },
  home: { power: 0, daily: 0, status: 'idle' },
  wallbox: { power: 0, energy_session: 0, status: 'idle', vehicle_connected: false },
  system: { model: 'SH15T', battery_model: 'SBR096', wallbox_model: 'AC22E-01', connected: false }
};

// ===== MODBUS CLIENTS =====
const inverterClient = new ModbusRTU();
const ihomeClient = new ModbusRTU();

let inverterConnected = false;
let ihomeConnected = false;

async function connectInverter() {
  try {
    await inverterClient.connectTCP(CONFIG.inverter.ip, { port: CONFIG.inverter.port });
    inverterClient.setID(CONFIG.inverter.unitId);
    inverterClient.setTimeout(5000);
    inverterConnected = true;
    solarData.system.connected = true;
    console.log('Connected to SH15T inverter at', CONFIG.inverter.ip);
  } catch (err) {
    console.error('Inverter connection failed:', err.message);
    inverterConnected = false;
    setTimeout(connectInverter, 10000);
  }
}

async function connectIHome() {
  try {
    await ihomeClient.connectTCP(CONFIG.ihome.ip, { port: CONFIG.ihome.port });
    ihomeClient.setID(CONFIG.ihome.unitId);
    ihomeClient.setTimeout(5000);
    ihomeConnected = true;
    console.log('Connected to iHome Manager at', CONFIG.ihome.ip);
  } catch (err) {
    console.error('iHome connection failed:', err.message);
    ihomeConnected = false;
    setTimeout(connectIHome, 10000);
  }
}

// Sungrow SH15T Modbus Register Map (Input Registers)
// Register 13000: Running state (U16)
//   Bits indicate: 0x0004 = normal operation
// Register 13001: Daily PV generation (U16, 0.1 kWh)
// Register 5016:  MPPT total power (U16, W) - only low word relevant for <65kW
// Register 13021: Battery power (U16, W)
// Register 13022: Battery SOC (U16, 0.1%)
// Register 13017: Total active power / Export power (U16, W)
// Register 13009: Export power to grid (S32, W)
// Running state bits determine battery charge/discharge direction.

async function readInverterData() {
  if (!inverterConnected) return;

  try {
    // PV Total Power - Register 5016 (U16, unit: W)
    const pvData = await inverterClient.readInputRegisters(5016, 1);
    solarData.pv.power = pvData.data[0] < 80 ? 0 : pvData.data[0];

    // PV Daily Generation - Register 13001 (U16, unit: 0.1 kWh)
    const pvDaily = await inverterClient.readInputRegisters(13001, 1);
    solarData.pv.daily = pvDaily.data[0] / 10;

    // Battery SOC - Register 13022 (U16, unit: 0.1%)
    const socData = await inverterClient.readInputRegisters(13022, 1);
    solarData.battery.soc = socData.data[0] / 10;

    // Battery Power - Register 13021 (U16, unit: W)
    const batPower = await inverterClient.readInputRegisters(13021, 1);
    let batteryPower = batPower.data[0];

    // Register 13020 contains battery direction info
    // Observed: 7 (0b111) when charging at low rate near full SOC
    // Sungrow SH series: bit1 (0x02) = charging, bit2 (0x04) = discharging
    const batDir = await inverterClient.readInputRegisters(13020, 1);
    const dirVal = batDir.data[0];
    if (dirVal & 0x04) {
      // Bit 2 set: discharging
      batteryPower = -batteryPower;
    }
    // If bit1 (0x02) set: charging → keep positive (default)

    solarData.battery.power = batteryPower;
    solarData.battery.status = batteryPower > 50 ? 'charging' : batteryPower < -50 ? 'discharging' : 'idle';

    // Grid Power - Register 13009/13010 (S32, W)
    // positive=import, negative=export
    // May be 0 if smart meter is connected via iHome Manager instead
    const gridData = await inverterClient.readInputRegisters(13009, 2);
    let gridPower = gridData.data[0] + (gridData.data[1] << 16);
    if (gridPower > 0x7FFFFFFF) gridPower -= 0x100000000;

    solarData.grid.power = gridPower;
    solarData.grid.status = gridPower > 50 ? 'importing' : gridPower < -50 ? 'exporting' : 'idle';

    // Daily Export - Register 13038 (U16, 0.1 kWh)
    const dailyExp = await inverterClient.readInputRegisters(13038, 1);
    if (dailyExp.data[0] > 0) {
      solarData.grid.daily_export = dailyExp.data[0] / 10;
    }

    solarData.pv.status = solarData.pv.power > 50 ? 'producing' : 'idle';
  } catch (err) {
    console.error('Inverter read error:', err.message);
    inverterConnected = false;
    inverterClient.close(() => {});
    setTimeout(connectInverter, 5000);
  }
}

// iHome Manager - Grid import/export totals and meter data
async function readIHomeData() {
  if (!ihomeConnected) return;

  try {
    // Try multiple register ranges to find grid data
    // Register 13000 on iHome: raw=[0, 416] → 416 in high word = could be 0.1kWh
    const reg13000 = await ihomeClient.readInputRegisters(13000, 2);
    // High word has the value: 416 = 41.6 kWh (total?) or daily PV
    // Register 13038: raw=[0, 34] → 34 in high word = 3.4 kWh daily export
    const reg13038 = await ihomeClient.readInputRegisters(13038, 2);
    const dailyExport = reg13038.data[1] / 10;
    if (dailyExport > 0) {
      solarData.grid.daily_export = dailyExport;
    }

    // Try register 13034 for daily import (was 0 earlier, might be because no import today)
    const reg13034 = await ihomeClient.readInputRegisters(13034, 2);
    const dailyImport = (reg13034.data[0] + (reg13034.data[1] << 16)) / 10;
    if (dailyImport > 0) {
      solarData.grid.daily_import = dailyImport;
    }

    // Grid power from iHome register 5030 (positive = export)
    try {
      const meterPower = await ihomeClient.readInputRegisters(5030, 1);
      let gridW = meterPower.data[0];
      if (gridW > 32767) gridW -= 65536; // S16
      // Negate: our convention is positive=import, negative=export
      gridW = -gridW;
      solarData.grid.power = gridW;
      solarData.grid.status = gridW > 50 ? 'importing' : gridW < -50 ? 'exporting' : 'idle';
    } catch(e) {}
  } catch (err) {
    console.error('iHome read error:', err.message);
    ihomeConnected = false;
    ihomeClient.close(() => {});
    setTimeout(connectIHome, 5000);
  }
}

// ===== DEMO MODE SIMULATION =====
function simulateData() {
  const hour = new Date().getHours();
  const minute = new Date().getMinutes();
  const timeOfDay = hour + minute / 60;
  const sunFactor = Math.max(0, Math.sin((timeOfDay - 5.5) / 13 * Math.PI));
  const cloudNoise = 0.8 + Math.random() * 0.2;

  const pvPower = Math.round(14500 * sunFactor * cloudNoise);
  const homePower = Math.round(800 + Math.random() * 1500 + (hour >= 17 && hour <= 22 ? 1800 : 0));
  const wallboxPower = solarData.wallbox.vehicle_connected ? (3700 + Math.round(Math.random() * 300)) : 0;
  const totalConsumption = homePower + wallboxPower;

  let batteryPower = 0;
  let gridPower = 0;
  const surplus = pvPower - totalConsumption;

  if (surplus > 0) {
    if (solarData.battery.soc < 95) {
      batteryPower = Math.min(surplus * 0.6, 5000);
      gridPower = -(surplus - batteryPower);
    } else {
      batteryPower = Math.min(surplus * 0.1, 1000);
      gridPower = -(surplus - batteryPower);
    }
  } else {
    const deficit = Math.abs(surplus);
    if (solarData.battery.soc > 15) {
      batteryPower = -Math.min(deficit * 0.7, 5000);
      gridPower = Math.max(0, deficit + batteryPower);
    } else {
      gridPower = deficit;
    }
  }

  solarData.battery.soc += (batteryPower / 9600) * 0.08;
  solarData.battery.soc = Math.max(5, Math.min(100, solarData.battery.soc));

  if (gridPower < 0) {
    solarData.grid.daily_export += Math.abs(gridPower) / 1000 * (2 / 3600);
    solarData.grid.daily_export = Math.round(solarData.grid.daily_export * 100) / 100;
  } else if (gridPower > 0) {
    solarData.grid.daily_import += gridPower / 1000 * (2 / 3600);
    solarData.grid.daily_import = Math.round(solarData.grid.daily_import * 100) / 100;
  }

  solarData.pv.power = pvPower;
  solarData.pv.daily += pvPower / 1000 * (2 / 3600);
  solarData.pv.daily = Math.round(solarData.pv.daily * 100) / 100;
  solarData.battery.power = batteryPower;
  solarData.battery.status = batteryPower > 50 ? 'charging' : batteryPower < -50 ? 'discharging' : 'idle';
  solarData.grid.power = gridPower;
  solarData.grid.status = gridPower > 50 ? 'importing' : gridPower < -50 ? 'exporting' : 'idle';
  solarData.home.power = homePower;
  solarData.home.daily += homePower / 1000 * (2 / 3600);
  solarData.home.daily = Math.round(solarData.home.daily * 100) / 100;
  solarData.wallbox.power = wallboxPower;
  solarData.wallbox.vehicle_connected = true;
}

// ===== DATA LOGGING =====
function getDataFilePath(date) {
  const d = date || new Date();
  const dateStr = d.toISOString().split('T')[0];
  return path.join(DATA_DIR, `${dateStr}.json`);
}

function loadDayData(date) {
  const filePath = getDataFilePath(date);
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      return [];
    }
  }
  return [];
}

function saveReading() {
  const now = new Date();
  const reading = {
    t: now.toISOString(),
    pv: solarData.pv.power,
    battery: solarData.battery.power,
    soc: Math.round(solarData.battery.soc),
    grid: solarData.grid.power,
    home: solarData.home.power,
    wallbox: solarData.wallbox.power
  };

  const filePath = getDataFilePath(now);
  const dayData = loadDayData(now);
  dayData.push(reading);
  fs.writeFileSync(filePath, JSON.stringify(dayData), 'utf8');
}

function generateDemoHistory() {
  const now = new Date();
  const filePath = getDataFilePath(now);
  if (fs.existsSync(filePath)) return;

  const history = [];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  for (let min = 0; min < now.getHours() * 60 + now.getMinutes(); min += 2) {
    const t = new Date(today.getTime() + min * 60000);
    const hour = min / 60;
    const sunFactor = Math.max(0, Math.sin((hour - 5.5) / 13 * Math.PI));
    const cloud = 0.75 + Math.random() * 0.25;
    const pvPower = Math.round(14500 * sunFactor * cloud);
    const homePower = Math.round(800 + Math.random() * 1500 + (hour >= 17 ? 1800 : 0));
    const wallboxPower = hour >= 8 && hour <= 16 ? 3700 : 0;
    const surplus = pvPower - homePower - wallboxPower;
    let batteryPower = 0, gridPower = 0, soc = 30 + min * 0.05;
    if (surplus > 0) {
      batteryPower = Math.min(surplus * 0.6, 5000);
      gridPower = -(surplus - batteryPower);
    } else {
      batteryPower = Math.max(surplus * 0.7, -5000);
      gridPower = Math.max(0, Math.abs(surplus) - Math.abs(batteryPower));
    }
    soc = Math.max(5, Math.min(98, soc));

    history.push({
      t: t.toISOString(),
      pv: pvPower,
      battery: Math.round(batteryPower),
      soc: Math.round(soc),
      grid: Math.round(gridPower),
      home: homePower,
      wallbox: wallboxPower
    });
  }

  fs.writeFileSync(filePath, JSON.stringify(history), 'utf8');
}

// ===== START =====
if (CONFIG.demoMode) {
  console.log('Running in DEMO mode');
  generateDemoHistory();
  solarData.wallbox.vehicle_connected = true;
  setInterval(simulateData, 2000);
} else {
  console.log('Connecting to Modbus devices...');
  connectInverter();
  connectIHome();
  setInterval(async () => {
    await readInverterData();
    await readIHomeData();
    // Home = PV + Grid - Battery (grid: positive=import, negative=export; battery: positive=charge)
    const pvW = solarData.pv.power;
    const batW = solarData.battery.power;
    const gridW = solarData.grid.power;
    solarData.home.power = Math.max(0, Math.round(pvW + gridW - batW));
  }, 3000);
}

setInterval(saveReading, 30000);
setTimeout(saveReading, 2000);

// ===== API ROUTES =====
app.get('/api/solar', (req, res) => {
  res.json(solarData);
});

app.get('/api/history/:date?', (req, res) => {
  let date;
  if (req.params.date) {
    date = new Date(req.params.date);
  } else {
    date = new Date();
  }
  const data = loadDayData(date);
  res.json(data);
});

app.get('/api/status', (req, res) => {
  res.json({
    demoMode: CONFIG.demoMode,
    inverterConnected,
    ihomeConnected,
    inverterIp: CONFIG.inverter.ip,
    ihomeIp: CONFIG.ihome.ip
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Solar Dashboard running at http://localhost:${PORT}`);
});
