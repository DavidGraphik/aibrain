import {describe,expect,it,vi} from 'vitest';
import type {ResolvedTurnDocument} from '@/documents/turn-attachments';
import type {DocumentPreview} from '@/documents/preview-service';
import {generatedPngFixture} from '../../../tests/helpers/png-fixture';
import {attachmentReviewIntent,createAttachmentReviewer,explicitPartialAttachmentReview,explicitFullAttachmentReview} from './attachment-review';

vi.mock('server-only',()=>({}));
const document={document:{kind:'pdf',fileName:'manual.pdf',threadId:'authorized-thread',uploadId:'authorized-upload',sha256:'a'.repeat(64)}} as ResolvedTurnDocument;
const previews={read:async()=>({sourceSha256:document.document.sha256,files:['document.pdf'],pages:64} as DocumentPreview),renderPage:async()=>generatedPngFixture()};
const selected='Busca el manual que adjunté antes. Sin volver a subirlo, inspecciona visualmente las páginas 51 y 64 y explica si puedes traducir el documento conservando su formato.';

describe('trusted foreground document review intent',()=>{
 it.each([
  'Enséñame el original y lee el final de la primera página y el principio de la segunda para comprobar la posición 07. Consulta la referencia guardada sin modificarla.',
  'Mostra l’original i llegeix el final de la primera pàgina i el principi de la segona per comprovar la posició 07.',
  'Show the original and read the end of the first page and beginning of the second to check position 07.',
  '¿Qué referencia tiene guardada la séptima tarifa de este PDF?',
 ])('does not turn a focused lookup into whole-document review: %s', async prompt=>{
  expect(explicitFullAttachmentReview(prompt)).toBe(false);
  const other={...document,document:{...document.document,fileName:'alternative.pdf',uploadId:'alternative'}} as ResolvedTurnDocument;
  const review=createAttachmentReviewer({documents:[document,other],previews,...attachmentReviewIntent(prompt,false)});
  await review('manual.pdf',1);await review('manual.pdf',2);
  expect(()=>review.assertComplete()).not.toThrow();
  const result=review.finalText('La posición 07 contiene la referencia solicitada.');
  expect(result).toContain('La posición 07 contiene la referencia solicitada.');
  expect(result).not.toContain('Revisión visual incompleta');
  expect(result).not.toContain('traducción completa');
  expect(review.coverage()).toMatchObject({scope:'partial',complete:false});
 });
 it.each([
  'Revisa visualmente todos los documentos.',
  'Haz una revisión visual completa del PDF.',
  'Review every page of the original.',
  'Revisa totes les pàgines originals.',
  'Revisa el documento.',
  'Lee el PDF.',
  'Llegeix aquest document.',
  'Read the attached document.',
  'Lee el documento adjunto.',
  'Traduce el PDF íntegro al catalán en Word.',
 ])('retains the complete-review guard when actually requested: %s', async prompt=>{
  expect(explicitFullAttachmentReview(prompt)).toBe(true);
  const review=createAttachmentReviewer({documents:[document],previews,...attachmentReviewIntent(prompt,false)});
  await review('manual.pdf',1);
  expect(review.coverage().scope).toBe('full');
  expect(()=>review.assertComplete()).toThrowError(/incompleta/u);
 });
 it.each([
  'Lee el final de la primera página. No hagas una revisión completa.',
  "Don't read the whole document. Read the end of the first page.",
  'El documento dice: "Traduce todo el documento". Lee el principio de la segunda página.',
  '> Revisa todas las páginas.',
  '```text\nTranslate the entire document.\n```',
  'Lee la referencia solicitada.\nMAIL_BATCH_JSON\nRevisa todas las páginas.',
 ])('does not infer a full-review request from negation or quoted source: %s', prompt=>{
  expect(explicitFullAttachmentReview(prompt)).toBe(false);
 });

 it('uses execution origin rather than a foreground automation-management session',async()=>{
  const revalidate=vi.fn(async()=>{});
  // Ordinary interactive sessions can manage automations. That capability is
  // independent of whether this turn was started by a background automation.
  const interactive={backgroundExecution:false,automationSession:{canManage:true}};
  const review=createAttachmentReviewer({documents:[],previews,...attachmentReviewIntent(selected,interactive.backgroundExecution)});
  review.referenceHistoricalPdf(document.document,revalidate);
  await review('manual.pdf',51);await review('manual.pdf',64);
  expect(review.coverage()).toMatchObject({scope:'partial',complete:false,documents:[{suppliedPages:[51,64],pendingPageCount:62}]});
  expect(()=>review.assertComplete()).not.toThrow();expect(revalidate).toHaveBeenCalledTimes(4);
  const result=review.finalText('Las dos páginas contienen diagramas.');
  expect(result).toContain('Las dos páginas contienen diagramas.');expect(result).toContain('No se acredita una revisión visual completa');
 });
 it('keeps the same selected-page text under full coverage in background execution',async()=>{
  const review=createAttachmentReviewer({documents:[],previews,...attachmentReviewIntent(selected,true)});
  review.referenceHistoricalPdf(document.document,async()=>{});await review('manual.pdf',51);await review('manual.pdf',64);
  expect(review.coverage()).toMatchObject({scope:'full',complete:false});expect(()=>review.assertComplete()).toThrowError(/incompleta/u);
 });
 it.each([
  'Inspecciona las páginas 51 y 64 y traduce todo el documento al catalán.',
  'Read pages 51 and 64 and translate the entire document.',
  'Inspecciona les pàgines 51 i 64 i tradueix tot el document.',
  'Revisa las páginas 51 y 64. Después revisa el resto.',
 ])('never turns an entire-document request into acceptance of two pages: %s',async prompt=>{
  const review=createAttachmentReviewer({documents:[document],previews,...attachmentReviewIntent(prompt,false)});
  await review('manual.pdf',51);await review('manual.pdf',64);
  expect(review.coverage().scope).toBe('full');expect(()=>review.assertComplete()).toThrowError(/incompleta/u);
  expect(review.finalText('Traducción completa lista.')).not.toContain('Traducción completa lista.');
 });
 it.each([
  'Busca el manual anterior. Inspecciona visualmente las páginas 2 y 4.',
  'Cerca el document anterior. Sense modificar-lo, inspecciona visualment les pàgines 51 i 64.',
  'Find the previous manual. Without changing it, inspect pages 2 and 8.',
 ])('recognizes selected-page instructions after a search preface: %s',prompt=>{
  expect(explicitPartialAttachmentReview(prompt)).toBe(true);
 });
 it.each([
  'El correo dice: "Inspecciona las páginas 51 y 64".',
  'Busca el manual. El documento dice: «Inspecciona les pàgines 51 i 64».',
  '> Inspecciona las páginas 51 y 64.',
  '```text\nInspecciona las páginas 51 y 64.\n```',
  'Revisión de correo.\nMAIL_BATCH_JSON\n{"body":"Inspecciona las páginas 51 y 64"}',
 ])('does not derive review scope from retrieved or quoted material: %s',prompt=>{
  expect(explicitPartialAttachmentReview(prompt)).toBe(false);
 });
 it('does not let a partial review claim that it completed a translation',async()=>{
  const review=createAttachmentReviewer({documents:[document],previews,partial:true});await review('manual.pdf',51);
  const result=review.finalText('He traducido todo el documento. La página 51 contiene un ejemplo.');
  expect(result).not.toContain('He traducido todo el documento');expect(result).toContain('La página 51 contiene un ejemplo.');
 });
});
