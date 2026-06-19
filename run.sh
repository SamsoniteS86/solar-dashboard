#!/bin/bash

CONFIG_PATH=/data/options.json

if [ -f "$CONFIG_PATH" ]; then
  export INVERTER_IP=$(jq -r '.inverter_ip' $CONFIG_PATH)
  export INVERTER_PORT=$(jq -r '.inverter_port' $CONFIG_PATH)
  export IHOME_IP=$(jq -r '.ihome_ip' $CONFIG_PATH)
  export IHOME_PORT=$(jq -r '.ihome_port' $CONFIG_PATH)
  export DEMO_MODE=$(jq -r '.demo_mode' $CONFIG_PATH)
fi

cd /app
exec node server.js
