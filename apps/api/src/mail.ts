// @ts-types="./nodemailer.d.ts"
import nodemailer from "npm:nodemailer@9.0.3";

export type IdentityMailKind = "email_verification" | "password_reset";
export interface IdentityMailer {
  send(
    input: { to: string; kind: IdentityMailKind; token: string; url: string },
    signal?: AbortSignal,
  ): Promise<void>;
  close?(): Promise<void> | void;
}

export class TestIdentityMailer implements IdentityMailer {
  readonly messages: Array<{ to: string; kind: IdentityMailKind; token: string; url: string }> = [];
  send(message: { to: string; kind: IdentityMailKind; token: string; url: string }) {
    this.messages.push(structuredClone(message));
    return Promise.resolve();
  }
}

export function smtpIdentityMailer(smtpUrl: string, from: string): IdentityMailer {
  const transports = new Set<ReturnType<typeof nodemailer.createTransport>>();
  return {
    async send(input, signal) {
      const transport = nodemailer.createTransport(smtpUrl);
      transports.add(transport);
      const verification = input.kind === "email_verification";
      const abort = () => transport.close();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (signal?.aborted) throw signal.reason;
        await transport.sendMail({
          from,
          to: input.to,
          subject: verification ? "Verify your DG Chat email" : "Reset your DG Chat password",
          text: `${verification ? "Verify your email" : "Reset your password"}: ${input.url}`,
        });
        if (signal?.aborted) throw signal.reason;
      } finally {
        signal?.removeEventListener("abort", abort);
        transports.delete(transport);
        transport.close();
      }
    },
    close() {
      for (const transport of transports) transport.close();
      transports.clear();
    },
  };
}

export const disabledIdentityMailer: IdentityMailer = {
  send: () => Promise.reject(new Error("SMTP is not configured")),
};
