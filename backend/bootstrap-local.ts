import path from "node:path";
import { makeLocal } from "./local.ts";
import { z } from "zod";
const email = z.string().email().parse(process.argv[2]).toLowerCase();
const { runtime, close } = await makeLocal({
  directory: path.resolve(process.env.TSUNAGU_LOCAL_DIR ?? ".local"),
  origin: `http://127.0.0.1:${process.env.PORT ?? 4180}`,
});
await runtime.db.query(
  "INSERT INTO ops_assignments(email,role) VALUES (?,'ops_owner') ON CONFLICT(email) DO NOTHING",
  [email],
);
console.log(
  "Local operator registered. Sign in through the common login with email OTP, then enroll an authenticator.",
);
close();
