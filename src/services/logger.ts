import winston, { createLogger, format, transports } from "winston";
import { addColors } from "winston/lib/winston/config";
const { combine, timestamp, printf, colorize } = format;
export const myFormat = printf(
  ({ level, message, label, timestamp, service }) => {
    return `[${timestamp}] [${service}] [${level}] [${label}]: ${message}`;
  }
);

export default class Logger {
  logger: winston.Logger;
  constructor(service: string) {
    const transportsList: winston.transport[] = [new transports.Console()];
    transportsList.push(
      new transports.File({ filename: service + ".log", dirname: "logs" }),
      new transports.File({ filename: "combined.log", dirname: "logs" })
    );
    this.logger = createLogger({
      levels: {
        error: 0,
        warn: 1,
        info: 2,
        debug: 4,
        verbose: 5,
        silly: 6,
      },
      level: "silly",
      defaultMeta: {
        service,
      },
      format: combine(
        timestamp({ format: "ddmm-HH:mm:ss" }),
        myFormat,
        colorize({ all: true })
      ),
      transports: transportsList,
    });
    addColors({
      info: "bold green",
      warn: "italic yellow",
      error: "bold red",
      debug: "blue",
      verbose: "cyan",
      silly: "white",
    });
  }
  log(data: { level: string; label: string; message: string }) {
    this.logger.log(data);
  }
}
