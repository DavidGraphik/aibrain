import { expect, it } from "vitest";
import { continuingDocumentUploads } from "./continuing-document-uploads";
const id = "43361fef-08c8-45ad-aa30-8993ebd8f2f0";
const attachment = {id, name:"original.xlsx", mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",size:10};
it("continues the uploaded original after text follow-ups, without using a generated assistant workbook", () => {
  expect(continuingDocumentUploads([
    {role:"user",attachments:[attachment]},
    {role:"assistant",attachments:[{...attachment,id:"95586709-184b-49c6-a363-f806c65f7075",name:"generated.xlsx"}]},
    {role:"user",attachments:[]},
  ])).toEqual([id]);
});
it("a newer upload replaces the previous batch; image context and paths cannot revive an older workbook", () => {
  const first = {role:"user" as const,attachments:[attachment]};
  expect(continuingDocumentUploads([first,{role:"user",attachments:[{...attachment,id:"95586709-184b-49c6-a363-f806c65f7075",mimeType:"application/pdf"}]}])).toEqual(["95586709-184b-49c6-a363-f806c65f7075"]);
  expect(continuingDocumentUploads([first,{role:"user",attachments:[{...attachment,mimeType:"image/jpeg"}]}])).toEqual([]);
  expect(continuingDocumentUploads([{role:"user",attachments:[{...attachment,id:"../other-thread/original.xlsx"}]}])).toEqual([]);
});
it("a branch does not reattach original staging IDs from its parent thread", () => {
  const inherited = {role:"user" as const, attachments:[attachment], createdAt:"2026-10-10T08:00:00Z"};
  const cutoff = "2026-10-11T08:00:00Z";
  expect(continuingDocumentUploads([inherited],cutoff)).toEqual([]);
  const own = {...inherited, createdAt:"2026-10-11T08:01:00Z", attachments:[{...attachment,id:"95586709-184b-49c6-a363-f806c65f7075"}]};
  expect(continuingDocumentUploads([inherited,own],cutoff)).toEqual([own.attachments[0].id]);
});
