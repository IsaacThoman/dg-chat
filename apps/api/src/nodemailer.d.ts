export interface MailOptions {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface Transport {
  sendMail(options: MailOptions): Promise<unknown>;
  close(): void;
}

declare const nodemailer: {
  createTransport(url: string): Transport;
};

export default nodemailer;
