import { z } from "zod";
export type ConfigurationState = "missing" | "invalid" | "configured";
export function parseAssistantProvider(
  raw: string | undefined,
  search: boolean,
) {
  if (!raw)
    return { state: "missing" as ConfigurationState, config: undefined };
  try {
    const endpoint = z
      .object({
        url: z
          .string()
          .url()
          .refine((s) => {
            const u = new URL(s);
            return u.protocol === "https:" && !u.username && !u.password;
          }),
        token: z.string().optional(),
        ...(search
          ? {
              allowedHosts: z
                .array(z.string().regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/))
                .min(1)
                .max(30),
            }
          : {}),
      })
      .strict();
    const config = z
      .record(z.string().regex(/^[^:]+:[^:]+$/), endpoint)
      .parse(JSON.parse(raw));
    return { state: "configured" as ConfigurationState, config };
  } catch {
    return { state: "invalid" as ConfigurationState, config: undefined };
  }
}
