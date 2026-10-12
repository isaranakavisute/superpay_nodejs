import pino from 'pino';
import config from './config.js';

const transport = config.isProduction
  ? undefined
  : {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
    };

export const logger = pino({
  level: config.logLevel,
  transport,
  redact: {
    // Keys and signatures never reach the logs (x-console-key also derives the secret-box key).
    paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-console-key"]', 'req.headers["x-api-key"]',
      'req.headers["x-signature"]', '*.password', '*.secretKey', '*.apiKey', '*.signingSecret'],
    censor: '[redacted]',
  },
});

export default logger;
