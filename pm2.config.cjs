const path = require("path");
const appName = process.env.APP_NAME || path.basename(__dirname);
const deployBase = `/var/www/${appName}`;

module.exports = {
  apps: [
    {
      name: appName,
      script: "./bin/app",
      cwd: `${deployBase}/current`,
      env: {
        PORT: 7582,
        NODE_ENV: "production",
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      error_file: `${deployBase}/logs/error.log`,
      out_file: `${deployBase}/logs/out.log`,
      merge_logs: true,
      time: true,
    },
  ],
};
