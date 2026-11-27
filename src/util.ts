export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
