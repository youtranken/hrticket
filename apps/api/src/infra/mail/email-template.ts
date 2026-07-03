/**
 * A small, email-client-safe HTML shell for transactional mail (OTP, password reset,
 * auto-ack). Table layout + inline styles only (Gmail/Outlook strip <style> and flex).
 * Navy header bar + a white card on a light canvas — matches the app's brand.
 */
const FOOTER = '© Phú Mỹ Hưng · HRIS / C&B';

export function emailShell(opts: { heading: string; bodyHtml: string }): string {
  return `<div style="margin:0;padding:24px 0;background:#f4f6f8;font-family:'Segoe UI',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 18px rgba(15,27,51,0.08);">
        <tr><td style="background:#1F3A5F;padding:18px 28px;color:#ffffff;font-size:17px;font-weight:600;letter-spacing:.2px;">Phú Mỹ Hưng · HRIS</td></tr>
        <tr><td style="padding:26px 28px;color:#243043;font-size:15px;line-height:1.65;">
          <h2 style="margin:0 0 14px;color:#1F3A5F;font-size:18px;">${opts.heading}</h2>
          ${opts.bodyHtml}
        </td></tr>
        <tr><td style="padding:16px 28px;background:#f7f8fb;color:#8a93a3;font-size:12px;border-top:1px solid #eaedf3;">${FOOTER}</td></tr>
      </table>
    </td></tr>
  </table>
</div>`;
}
