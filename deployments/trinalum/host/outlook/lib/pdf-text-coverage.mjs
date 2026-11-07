// pdftotext separates pages with form-feed. PDF page count is independently
// obtained from pdfinfo; a readable first page cannot attest the entire PDF.
export function pdfTextCoverage(text, pageCount) {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 10000 || typeof text !== 'string') {
    return {pageCount:null,textPageNumbers:[],visualReviewPages:[],textCoverage:'unknown'};
  }
  const pages=text.split('\f');
  if (pages.at(-1)==='' && pages.length>1) pages.pop();
  if (pages.length!==pageCount) {
    return {pageCount,textPageNumbers:[],visualReviewPages:[],textCoverage:'unknown'};
  }
  const textPageNumbers=[],visualReviewPages=[];
  pages.forEach((page,index)=>(page.replaceAll('\0','').trim()?textPageNumbers:visualReviewPages).push(index+1));
  return {pageCount,textPageNumbers,visualReviewPages,textCoverage:visualReviewPages.length?'partial':'complete'};
}
