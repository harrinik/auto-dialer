module.exports = {
  apps: [
    {
      name:          'controller',
      script:        './controller.js',
      watch:         false,
      restart_delay: 3000,
      env: { NODE_ENV: 'production' }
    },
    {
      name:          'worker',
      script:        './worker.js',
      instances:     1,
      watch:         false,
      restart_delay: 5000,
      env: { NODE_ENV: 'production' }
    }
  ]
};