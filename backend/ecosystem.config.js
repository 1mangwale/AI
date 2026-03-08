module.exports = {
  apps: [{
    name: "mangwale-backend",
    script: "npm",
    args: "run start:prod",
    cwd: "/home/ubuntu/Devs/MangwaleAI/backend",
    env: {
      NODE_ENV: "production",
    },
    max_memory_restart: "500M",
    error_file: "/home/ubuntu/logs/mangwale-backend-error.log",
    out_file: "/home/ubuntu/logs/mangwale-backend-out.log",
    time: true,
  }],
};
