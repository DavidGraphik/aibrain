// Stream transport deliberately retains Bcc for editable drafts/archives.
// Raw SMTP transport does not rewrite headers: strip blind recipient headers
// from the frozen wire copy, retaining recipients only in the SMTP envelope.
export function smtpMessage(value){
 const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);
 const source=bytes.toString('latin1'),boundary=source.search(/\r?\n\r?\n/);
 if(boundary<0)return bytes;
 const header=source.slice(0,boundary).replace(/^(?:Bcc|Resent-Bcc):[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*(?:\r?\n|$)/gim,'');
 return Buffer.from(header.replace(/\r?\n$/,'')+source.slice(boundary),'latin1');
}
