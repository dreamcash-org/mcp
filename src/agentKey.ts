import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Hex, isHex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const defaultKeyFile = () =>
  process.env.DREAMCASH_AGENT_KEY_FILE ??
  join(homedir(), ".dreamcash", "agent-key.json");

/** A new pairing's key, until the user approves it; the paired key keeps working meanwhile */
export const pendingKeyFile = (file: string) => `${file}.pending`;

type StoredKey = { address: string; privateKey: Hex; createdAt: string };

/** A key file that's there but can't be read: never a reason to make a new key */
export class KeyUnreadable extends Error {
  constructor(
    readonly file: string,
    cause: unknown,
  ) {
    super(`the agent key at ${file} couldn't be read`, { cause });
  }
}

/** The agent's key saved in the file; undefined only when there is none */
export const storedAgentAccount = async (
  file = defaultKeyFile(),
): Promise<LocalAccount | undefined> => {
  try {
    const stored = JSON.parse(await readFile(file, "utf8")) as StoredKey;
    if (!isHex(stored.privateKey)) throw new Error("it holds no private key");
    return privateKeyToAccount(stored.privateKey);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    // ENOTDIR: a parent of the path is a file, so the key can't be there
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new KeyUnreadable(file, error);
  }
};

/**
 * A fresh key, replacing any before it in the file, readable only by this
 * machine's user. HL advises a new API wallet per approval. Written whole or
 * not at all: a half-written key file would lose the key.
 */
export const newAgentAccount = async (
  file = defaultKeyFile(),
): Promise<LocalAccount> => {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const stored: StoredKey = {
    address: account.address,
    privateKey,
    createdAt: new Date().toISOString(),
  };
  const written = `${file}.tmp`;
  // created here, never opened through whatever was at that path (a link
  // someone else planted would take the key where they chose)
  await rm(written, { force: true });
  await writeFile(written, JSON.stringify(stored, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  await chmod(written, 0o600);
  await rename(written, file);
  return account;
};

/** The user approved the pending key: it becomes the agent's key */
export const adoptPendingKey = (file: string) =>
  rename(pendingKeyFile(file), file);
