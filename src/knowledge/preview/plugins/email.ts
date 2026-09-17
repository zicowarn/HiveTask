/**
 * 邮件预览（.eml）：头信息（发件人/收件人/主题/时间）+ 纯文本或 HTML 正文 + 附件列表。
 *
 * 与 OFV 的 email 插件同思路，但只依赖 `postal-mime`（不引 msgreader/json 那一串），
 * 且 HTML 正文经 DOMPurify 清洗后才插入 —— 邮件正文是**不可信输入**。
 */
import type { PreviewContext, PreviewInstance, PreviewTool } from "../registry";
import { withFind } from "../dom-find";

export const EMAIL_EXTENSIONS = ["eml", "mime"];

export const emailPlugin = {
  tools: ["find"] satisfies PreviewTool[],
  id: "email",
  extensions: EMAIL_EXTENSIONS,
  async render(ctx: PreviewContext): Promise<PreviewInstance> {
    const [{ default: PostalMime }, { default: DOMPurify }] = await Promise.all([
      import("postal-mime"),
      import("dompurify"),
    ]);
    const text = await ctx.readText();
    const mail = await new PostalMime().parse(text);

    const wrap = document.createElement("div");
    wrap.className = "kb-email";

    const head = document.createElement("dl");
    head.className = "kb-email-head";
    const rows: [string, string][] = [
      ["发件人", mail.from?.address ? `${mail.from.name ?? ""} <${mail.from.address}>` : "—"],
      ["收件人", (mail.to ?? []).map((a) => a.address).join(", ") || "—"],
      ["主题", mail.subject ?? "—"],
      ["时间", mail.date ?? "—"],
    ];
    for (const [label, value] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      head.append(dt, dd);
    }
    wrap.appendChild(head);

    if (mail.attachments?.length) {
      const attachments = document.createElement("div");
      attachments.className = "kb-email-attachments";
      attachments.textContent = `附件：${mail.attachments.map((a) => a.filename ?? "(未命名)").join(", ")}`;
      wrap.appendChild(attachments);
    }

    const body = document.createElement("div");
    body.className = "kb-email-body markdown-body";
    if (mail.html) {
      // 邮件 HTML 属不可信内容：DOMPurify 清洗后再插入
      body.innerHTML = DOMPurify.sanitize(mail.html, { USE_PROFILES: { html: true } });
    } else {
      const pre = document.createElement("pre");
      pre.className = "kb-email-text";
      pre.textContent = mail.text ?? "(无正文)";
      body.appendChild(pre);
    }
    wrap.appendChild(body);

    ctx.container.replaceChildren(wrap);
    return withFind(ctx);
  },
};
