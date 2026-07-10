import nodemailer from "npm:nodemailer@7.0.3";

export type IdentityMailKind = "email_verification" | "password_reset";
export interface IdentityMailer {
  send(input: { to: string; kind: IdentityMailKind; token: string; url: string }): Promise<void>;
}

export class TestIdentityMailer implements IdentityMailer {
  readonly messages: Array<{ to: string; kind: IdentityMailKind; token: string; url: string }> = [];
  send(message: { to: string; kind: IdentityMailKind; token: string; url: string }) {
    this.messages.push(structuredClone(message));
    return Promise.resolve();
  }
}

export function smtpIdentityMailer(smtpUrl: string, from: string): IdentityMailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(input) {
      const verification = input.kind === "email_verification";
      await transport.sendMail({
        from,
        to: input.to,
        subject: verification ? "Verify your DG Chat email" : "Reset your DG Chat password",
        text: `${verification ? "Verify your email" : "Reset your password"}: ${input.url}`,
      });
    },
  };
}

export const disabledIdentityMailer: IdentityMailer = {
  send: () => Promise.reject(new Error("SMTP is not configured")),
};
