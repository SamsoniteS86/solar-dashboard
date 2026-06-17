document.addEventListener('DOMContentLoaded', () => {
  try { initFlowCanvas(); } catch(e) { console.error('Canvas init error:', e); }
  try { initChartModals(); } catch(e) { console.error('Chart init error:', e); }
  fetchData();
  setInterval(fetchData, 2000);
});

let flowData = {
  pv: 8450,
  battery: 2200,
  batteryStatus: 'charging',
  grid: -1200,
  gridStatus: 'exporting',
  home: 5050,
  wallbox: 3700
};

let canvas, ctx;
let time = 0;

function initFlowCanvas() {
  canvas = document.getElementById('flow-canvas');
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  animate();
}

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

function getNodeCenter(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
}

function drawGlowingLine(from, to, color, power, reverse) {
  if (power < 50) return;

  const intensity = Math.min(1, power / 12000);

  // Draw dashed glowing energy line
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);

  // Outer glow
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 8 + intensity * 12;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.15 + intensity * 0.1;
  ctx.lineWidth = 4 + intensity * 4;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();

  // Dashed line base
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.lineDashOffset = reverse ? time * 0.8 : -time * 0.8;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();

  // Bright animated traveling segment
  const speed = 0.002 + intensity * 0.003;
  const segLen = 0.25 + intensity * 0.1;
  const numSegs = 2;

  for (let i = 0; i < numSegs; i++) {
    let progress = ((time * speed) + (i / numSegs)) % 1;
    if (reverse) progress = 1 - progress;

    const segStart = progress;
    const segEnd = Math.min(1, progress + segLen);

    const x1 = from.x + dx * segStart;
    const y1 = from.y + dy * segStart;
    const x2 = from.x + dx * segEnd;
    const y2 = from.y + dy * segEnd;

    // Bright core segment
    const grad = ctx.createLinearGradient(x1, y1, x2, y2);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.3, color);
    grad.addColorStop(0.5, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.7, color);
    grad.addColorStop(1, 'rgba(255,255,255,0)');

    ctx.save();
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5 + intensity * 1.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10 + intensity * 10;
    ctx.globalAlpha = 0.7 + intensity * 0.3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  // Power label at midpoint
  const midX = from.x + dx * 0.5;
  const midY = from.y + dy * 0.5;
  const kw = (power / 1000).toFixed(2);

  ctx.save();
  ctx.font = '600 11px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Label background
  const labelW = ctx.measureText(kw + ' kW').width + 12;
  ctx.fillStyle = 'rgba(8, 12, 24, 0.8)';
  ctx.beginPath();
  const lx = midX - labelW / 2, ly = midY - 9;
  if (ctx.roundRect) {
    ctx.roundRect(lx, ly, labelW, 18, 4);
  } else {
    ctx.rect(lx, ly, labelW, 18);
  }
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Label text
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 4;
  ctx.fillText(kw + ' kW', midX, midY);
  ctx.restore();
}

function drawIdleLine(from, to, color) {
  if (!from || !to) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.12;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 8]);
  ctx.lineDashOffset = -time * 0.3;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
}

function animate() {
  time++;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const hub = getNodeCenter('center-hub');
  const pvPos = getNodeCenter('pv-node');
  const batPos = getNodeCenter('battery-node');
  const gridPos = getNodeCenter('grid-node');
  const wbPos = getNodeCenter('wallbox-node');

  if (!hub) return;

  let pvActive = false, batActive = false, gridActive = false, wbActive = false;

  // PV -> Home (hub)
  if (flowData.pv > 100 && pvPos) {
    drawGlowingLine(pvPos, hub, '#00e5ff', flowData.pv, false);
    pvActive = true;
  }

  // Home -> Battery (charging) or Battery -> Home (discharging)
  if (batPos) {
    if (flowData.batteryStatus === 'charging' && flowData.battery > 100) {
      drawGlowingLine(hub, batPos, '#00ff88', flowData.battery, false);
      batActive = true;
    } else if (flowData.batteryStatus === 'discharging' && Math.abs(flowData.battery) > 100) {
      drawGlowingLine(batPos, hub, '#00ff88', Math.abs(flowData.battery), true);
      batActive = true;
    }
  }

  // Home -> Grid (export) or Grid -> Home (import)
  if (gridPos) {
    if (flowData.gridStatus === 'exporting' && Math.abs(flowData.grid) > 100) {
      drawGlowingLine(hub, gridPos, '#7c4dff', Math.abs(flowData.grid), false);
      gridActive = true;
    } else if (flowData.gridStatus === 'importing' && Math.abs(flowData.grid) > 100) {
      drawGlowingLine(gridPos, hub, '#ff3d5a', Math.abs(flowData.grid), true);
      gridActive = true;
    }
  }

  // Home -> Wallbox
  if (flowData.wallbox > 100 && wbPos) {
    drawGlowingLine(hub, wbPos, '#00b8d4', flowData.wallbox, false);
    wbActive = true;
  }

  // Idle lines for inactive connections
  if (!pvActive && pvPos) drawIdleLine(pvPos, hub, '#00e5ff');
  if (!batActive && batPos) drawIdleLine(batPos, hub, '#00ff88');
  if (!gridActive && gridPos) drawIdleLine(gridPos, hub, '#7c4dff');
  if (!wbActive && wbPos) drawIdleLine(wbPos, hub, '#00b8d4');

  requestAnimationFrame(animate);
}

async function fetchData() {
  try {
    const res = await fetch('/api/solar');
    const data = await res.json();
    try {
      updateUI(data);
    } catch (uiErr) {
      console.error('UI update error:', uiErr);
    }
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

function formatPower(watts) {
  return (Math.abs(watts) / 1000).toFixed(2);
}

function updateUI(data) {
  flowData.pv = data.pv.power;
  flowData.battery = data.battery.power;
  flowData.batteryStatus = data.battery.status;
  flowData.grid = data.grid.power;
  flowData.gridStatus = data.grid.status;
  flowData.home = data.home.power;
  flowData.wallbox = data.wallbox.power;

  // PV
  document.getElementById('pv-power').textContent = formatPower(data.pv.power);
  document.getElementById('pv-daily').textContent = `${data.pv.daily} kWh heute`;

  // Home (center hub) - shows home consumption in Watt
  document.getElementById('home-power').textContent = Math.round(Math.abs(data.home.power));

  // Daily yield
  document.getElementById('daily-yield').textContent = Number(data.pv.daily).toFixed(1);

  // Battery
  document.getElementById('battery-power').textContent = formatPower(data.battery.power);
  const soc = Math.round(data.battery.soc);
  document.getElementById('battery-soc').textContent = soc + '%';

  const circumference = 2 * Math.PI * 26;
  const offset = circumference - (soc / 100) * circumference;
  document.getElementById('soc-circle').style.strokeDashoffset = offset;

  const batteryLevel = document.getElementById('battery-level');
  if (batteryLevel) {
    batteryLevel.style.height = soc + '%';
  }

  const batteryStatusEl = document.getElementById('battery-status-text');
  if (data.battery.status === 'charging') {
    batteryStatusEl.textContent = 'Laden';
    batteryStatusEl.style.color = 'var(--green)';
  } else if (data.battery.status === 'discharging') {
    batteryStatusEl.textContent = 'Entladen';
    batteryStatusEl.style.color = 'var(--red)';
  } else {
    batteryStatusEl.textContent = 'Standby';
    batteryStatusEl.style.color = 'var(--text-dim)';
  }

  // Grid
  document.getElementById('grid-power').textContent = formatPower(data.grid.power);
  const gridStatusEl = document.getElementById('grid-status-text');
  if (data.grid.status === 'exporting') {
    gridStatusEl.textContent = 'Einspeisung';
    gridStatusEl.style.color = 'var(--cyan)';
  } else if (data.grid.status === 'importing') {
    gridStatusEl.textContent = 'Netzbezug';
    gridStatusEl.style.color = 'var(--red)';
  } else {
    gridStatusEl.textContent = 'Idle';
    gridStatusEl.style.color = 'var(--text-dim)';
  }
  document.getElementById('grid-daily').textContent =
    `Exp: ${data.grid.daily_export} kWh | Imp: ${data.grid.daily_import} kWh`;

  const gridPulse = document.getElementById('grid-pulse');
  if (gridPulse) {
    if (data.grid.status === 'importing') {
      gridPulse.style.background = 'var(--red)';
      gridPulse.style.boxShadow = '0 0 10px var(--red-glow), 0 0 20px var(--red-glow)';
    } else {
      gridPulse.style.background = 'var(--cyan)';
      gridPulse.style.boxShadow = '0 0 10px var(--cyan-glow), 0 0 20px var(--cyan-glow)';
    }
  }

  // Wallbox
  document.getElementById('wallbox-power').textContent = formatPower(data.wallbox.power);
  document.getElementById('wallbox-session').textContent = `${data.wallbox.energy_session} kWh Session`;

  const led = document.getElementById('charger-led');
  if (led) {
    if (data.wallbox.power > 0) {
      led.style.borderColor = 'var(--cyan)';
    } else if (data.wallbox.vehicle_connected) {
      led.style.borderColor = 'var(--orange)';
    } else {
      led.style.borderColor = 'rgba(0, 229, 255, 0.2)';
      led.style.animation = 'none';
    }
  }

  const sunEffect = document.getElementById('sun-effect');
  if (sunEffect) {
    sunEffect.style.opacity = data.pv.power > 100 ? '1' : '0.1';
  }
}

// ===== CHART MODAL =====
let chartInstance = null;

function initChartModals() {
  const modal = document.getElementById('chart-modal');
  const backdrop = document.getElementById('chart-backdrop');
  const closeBtn = document.getElementById('chart-close');

  // PV click
  document.getElementById('pv-node').addEventListener('click', () => openChart('pv'));
  // Grid click
  document.getElementById('grid-node').addEventListener('click', () => openChart('grid'));
  // Home (center hub) click
  document.getElementById('center-hub').addEventListener('click', () => openChart('home'));

  closeBtn.addEventListener('click', closeChart);
  backdrop.addEventListener('click', closeChart);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeChart();
  });
}

function closeChart() {
  document.getElementById('chart-modal').classList.remove('active');
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
}

async function openChart(type) {
  const modal = document.getElementById('chart-modal');
  modal.classList.add('active');

  const titleEl = document.getElementById('chart-title');
  const titles = {
    pv: 'Photovoltaik — Tagesverlauf',
    grid: 'Stromnetz — Tagesverlauf',
    home: 'Hausverbrauch — Tagesverlauf'
  };
  titleEl.textContent = titles[type] || 'Tagesverlauf';

  try {
    const res = await fetch('/api/history');
    const history = await res.json();
    renderChart(history, type);
  } catch (err) {
    console.error('History fetch error:', err);
  }
}

function renderChart(history, type) {
  const canvas = document.getElementById('chart-canvas');
  if (chartInstance) {
    chartInstance.destroy();
  }

  // Filter: nur Zeitraum mit Solarproduktion anzeigen
  let firstSolar = history.findIndex(d => d.pv > 50);
  let lastSolar = history.length - 1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].pv > 50) { lastSolar = i; break; }
  }
  if (firstSolar < 0) firstSolar = 0;
  // Etwas Puffer: 10 Datenpunkte vor/nach
  firstSolar = Math.max(0, firstSolar - 10);
  lastSolar = Math.min(history.length - 1, lastSolar + 10);
  history = history.slice(firstSolar, lastSolar + 1);

  const labels = history.map(d => {
    const t = new Date(d.t);
    return t.getHours().toString().padStart(2, '0') + ':' + t.getMinutes().toString().padStart(2, '0');
  });

  // Thin out labels for readability
  const skipLabels = labels.map((l, i) => {
    if (i % Math.max(1, Math.floor(history.length / 20)) === 0) return l;
    return '';
  });

  let datasets = [];

  if (type === 'pv') {
    datasets = [{
      label: 'PV Leistung (W)',
      data: history.map(d => d.pv),
      borderColor: '#00e5ff',
      backgroundColor: 'rgba(0, 229, 255, 0.1)',
      fill: true,
      tension: 0.4,
      borderWidth: 2,
      pointRadius: 0
    }];
  } else if (type === 'grid') {
    datasets = [
      {
        label: 'Einspeisung (W)',
        data: history.map(d => d.grid < 0 ? Math.abs(d.grid) : 0),
        borderColor: '#7c4dff',
        backgroundColor: 'rgba(124, 77, 255, 0.1)',
        fill: true,
        tension: 0.4,
        borderWidth: 2,
        pointRadius: 0
      },
      {
        label: 'Netzbezug (W)',
        data: history.map(d => d.grid > 0 ? d.grid : 0),
        borderColor: '#ff3d5a',
        backgroundColor: 'rgba(255, 61, 90, 0.1)',
        fill: true,
        tension: 0.4,
        borderWidth: 2,
        pointRadius: 0
      }
    ];
  } else if (type === 'home') {
    datasets = [{
      label: 'Verbrauch (W)',
      data: history.map(d => d.home),
      borderColor: '#ff8c00',
      backgroundColor: 'rgba(255, 140, 0, 0.1)',
      fill: true,
      tension: 0.4,
      borderWidth: 2,
      pointRadius: 0
    }];
  }

  chartInstance = new Chart(canvas, {
    type: 'line',
    data: { labels: skipLabels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          labels: {
            color: '#94a8b8',
            font: { size: 11 }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(10, 18, 35, 0.95)',
          borderColor: 'rgba(0, 229, 255, 0.3)',
          borderWidth: 1,
          titleColor: '#00e5ff',
          bodyColor: '#c8e6f0',
          padding: 10,
          displayColors: true,
          callbacks: {
            title: function(items) {
              const idx = items[0].dataIndex;
              const t = new Date(history[idx].t);
              return t.getHours().toString().padStart(2, '0') + ':' +
                     t.getMinutes().toString().padStart(2, '0') + ' Uhr';
            },
            label: function(item) {
              const val = item.raw;
              if (val >= 1000) return ' ' + item.dataset.label + ': ' + (val / 1000).toFixed(2) + ' kW';
              return ' ' + item.dataset.label + ': ' + val + ' W';
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(0, 229, 255, 0.05)' },
          ticks: {
            color: '#5a8a9a',
            font: { size: 10 },
            maxRotation: 0
          }
        },
        y: {
          grid: { color: 'rgba(0, 229, 255, 0.05)' },
          ticks: {
            color: '#5a8a9a',
            font: { size: 10 },
            callback: function(val) {
              if (val >= 1000) return (val / 1000).toFixed(1) + ' kW';
              return val + ' W';
            }
          },
          beginAtZero: true
        }
      }
    }
  });
}
