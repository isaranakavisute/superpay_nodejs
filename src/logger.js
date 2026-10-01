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
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password'],
    censor: '[redacted]',
  },
});

export default logger;
