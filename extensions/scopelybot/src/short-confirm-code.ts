import { randomInt } from "node:crypto";
import * as fs from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

// A code is only a human reference. Sender/roster/channel/TTL and backend claim
// remain authoritative. Reservations prevent an old reference ever being issued
// again, even after consumption, failed delivery or a gateway restart.
export function makeShortCode(): string {
  const directory = process.env.SCOPELYBOT_CONFIRM_CODE_DIR;
  if (!directory || !isAbsolute(directory) || fs.realpathSync(directory) !== directory) {
    throw new Error("A persistent confirmation-code directory must be configured.");
  }
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    stat.uid !== userInfo().uid
  ) {
    throw new Error("Confirmation-code storage must be private and owned by this process.");
  }
  // No mkdir, cleanup or fallback: provision this on the persistent local POSIX
  // volume and preserve its complete history through deployments and rollbacks.
  for (let attempt = 0; attempt < 32; attempt++) {
    const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    let fd: number;
    try {
      fd = fs.openSync(
        join(directory, code),
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw error;
    }
    // Any later failure burns this name. Never remove it or retry a delivery.
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const directoryFd = fs.openSync(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
    return code;
  }
  throw new Error("Unable to reserve a new confirmation code; no prompt was issued.");
}
