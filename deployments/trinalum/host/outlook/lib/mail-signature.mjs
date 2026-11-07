import {createHash} from 'node:crypto';

const escapeHtml = text => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = text => String(text).replaceAll('\r\n','\n').replaceAll('\r','\n');

function linkedLine(text) {
  const pattern = /([^\s<>]+)<(https?:\/\/[^<>\s]+)>|(https?:\/\/[^\s<>]+)|((?:www\.)?linkedin\.com\/[^\s<>]+)|([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi;
  let result = '', offset = 0;
  for (const match of text.matchAll(pattern)) {
    result += escapeHtml(text.slice(offset, match.index));
    const label = match[1] ?? match[3] ?? match[4] ?? match[5];
    const href = match[2] ?? match[3] ?? (match[4] ? `https://${match[4]}` : `mailto:${match[5]}`);
    result += `<a href="${escapeHtml(href)}" style="color:inherit;text-decoration:underline">${escapeHtml(label)}</a>`;
    offset = match.index + match[0].length;
  }
  return result + escapeHtml(text.slice(offset));
}

export function renderMailSignature(signature) {
  if (typeof signature?.text !== 'string' || !signature.text.trim()) throw Error('Verified signature missing');
  const text = normalize(signature.text).trim();
  const legalAt = text.indexOf('La información contenida');
  if (legalAt < 1) throw Error('Verified legal notice missing');
  const header = text.slice(0, legalAt).split('\n').map(line => line.trim()).filter(line => line && !/^[-_─]{8,}$/.test(line));
  const legal = text.slice(legalAt);
  const logo = signature.inlineImage;
  if (!logo || logo.contentType !== 'image/png' || !/^[A-Za-z0-9+/]+={0,2}$/.test(logo.contentBytes ?? '')) throw Error('Verified signature logo missing');
  const bytes = Buffer.from(logo.contentBytes, 'base64');
  if (bytes.length < 8 || bytes.length > 256 * 1024 || bytes.toString('base64') !== logo.contentBytes ||
      !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || sha(bytes) !== logo.sha256) throw Error('Signature logo integrity mismatch');
  const contentId = `trinalum-signature-${logo.sha256.slice(0,24)}@operations.example.invalid`;
  const html = `<div data-trinalum-signature="v2" style="margin:12px 0 0;font-family:Aptos,Arial,sans-serif;font-size:12pt;color:#000;line-height:1.25">` +
    header.map(line => `<div style="margin:0;padding:0">${linkedLine(line)}</div>`).join('') +
    `<div style="margin:8px 0"><img src="cid:${contentId}" alt="Trinalum" width="120" height="58" style="display:block;border:0;width:120px;height:58px"></div>` +
    `<div data-trinalum-legal="true" style="margin:8px 0 0;font-size:8pt;line-height:1.2">${legal.split('\n').map(linkedLine).join('<br>')}</div></div>`;
  return {html, text, attachment:{name:'trinalum-logo.png', contentType:'image/png', contentId, contentBytes:logo.contentBytes, isInline:true}};
}

// This runs only inside freezeComposedDraft: approved drafts keep their frozen
// body and CID bytes even if the signature configuration later changes.
export function applyMailSignature(message, signature) {
  if (!message?.body || typeof message.body.content !== 'string') throw Error('Draft body required');
  const rendered = renderMailSignature(signature);
  const isHtml = String(message.body.contentType).toLowerCase() === 'html';
  let content = normalize(message.body.content);
  const close = isHtml ? content.search(/<\/body\s*>\s*(?:<\/html\s*>)?\s*$/i) : -1;
  const trailer = close >= 0 ? content.slice(close) : '';
  content = (close >= 0 ? content.slice(0,close) : content).trimEnd();
  if (!content.endsWith(rendered.html)) {
    // Replace only an exact trailing legacy signature; quoted signatures in
    // replies remain source material and must never be edited or deduplicated.
    const legacy = isHtml ? escapeHtml(signature.text).replaceAll('\n','<br>') : signature.text;
    if (content.endsWith(legacy)) {
      content = content.slice(0,-legacy.length).replace(isHtml ? /(?:\s*<br\s*\/?\s*>)*\s*$/i : /\s*$/, '');
    }
    if (!isHtml) content = escapeHtml(content).replaceAll('\n','<br>');
    content += rendered.html;
  }
  const attachments = message.attachments ?? [];
  const collisions = attachments.filter(item => String(item.contentId ?? '').replace(/^<|>$/g,'') === rendered.attachment.contentId);
  if (collisions.length > 1 || collisions.some(item => item.contentType !== 'image/png' || item.contentBytes !== rendered.attachment.contentBytes)) throw Error('Signature CID collision');
  message.body = {...message.body, contentType:'HTML', content:content + trailer};
  message.attachments = collisions.length ? attachments : [...attachments, rendered.attachment];
  return message;
}
