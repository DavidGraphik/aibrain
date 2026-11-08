/** Render provider email HTML as inert readable text; never mount remote markup. */
export function outreachMessageText(value:string):string {
 const text=value.replace(/<!--[^]*?-->/g,'').replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi,'').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<\/(?:div|p|li|tr|h[1-6])\s*>/gi,'\n').replace(/<[^>]*>/g,'');
 const named:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
 return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,entity:string)=>{
  if(entity[0]!=='#')return named[entity.toLowerCase()];
  const point=entity[1].toLowerCase()==='x'?parseInt(entity.slice(2),16):parseInt(entity.slice(1),10);
  return point>0&&point<=0x10ffff&&!(point>=0xd800&&point<=0xdfff)?String.fromCodePoint(point):'�';
 }).replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
