import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {OUTREACH_FINAL_CONTENT as content,OUTREACH_FINAL_CONTENT_COUNTS,OUTREACH_FINAL_SOURCE_SHA256,FINAL_REVIEW_CAMPAIGNS,getOutreachFinalContent} from '@/insijets/outreach-final-content';
import {importPhase1EditorialPack} from '@/insijets/outreach-editorial-import';

it('preserves all editorial fields of the final review source apart from environment-specific source metadata',()=>{
 expect(createHash('sha256').update(JSON.stringify(content)).digest('hex')).toBe(OUTREACH_FINAL_SOURCE_SHA256);
 expect(OUTREACH_FINAL_SOURCE_SHA256).toMatch(/^[a-f0-9]{64}$/);
 expect(JSON.stringify(content)).not.toContain('/Users/');
 expect(OUTREACH_FINAL_CONTENT_COUNTS).toEqual({profiles:15,signalChecks:75,sequences:18,messages:54});
 expect(content.scoring.mandatoryFilters.map(f=>f.id)).toEqual(['role','source','email','economic','eligibility','accountCoordination']);
 expect(content.scoring.commonLayer.reduce((n,f)=>n+f.capPoints,0)).toBe(100);
 expect(FINAL_REVIEW_CAMPAIGNS.some(c=>c.persona==='wealth-managers')).toBe(false);
 expect(FINAL_REVIEW_CAMPAIGNS.some(c=>c.persona==='pet-relocation')).toBe(true);
 expect(content.personas.reduce((n,p)=>n+p.sharePercent,0)).toBe(100);
 expect(content.personas.filter(p=>!p.monthOneEnabled).map(p=>p.id)).toEqual(['wealth_managers','art_galleries','yachting','politicians','pet_relocation']);
});
it('maps all 54 source subjects/bodies and thread rules identically to the configured pipeline importer',()=>{
 const imported=importPhase1EditorialPack(JSON.stringify(content));
 const strip=(c:typeof FINAL_REVIEW_CAMPAIGNS[number])=>({id:c.id,persona:c.persona,locale:c.locale,steps:c.steps,sendEnabled:c.sendEnabled});
 expect(FINAL_REVIEW_CAMPAIGNS.map(strip)).toEqual(imported.campaigns.map(strip));
 expect(FINAL_REVIEW_CAMPAIGNS.every(c=>c.sendEnabled===false&&c.steps.map(s=>s.offset).join(',')==='0,7,17')).toBe(true);
});
it('provides bounded source-specific reads for chat with honest approval and unknown-ID denial',()=>{
 expect(getOutreachFinalContent({section:'profile',personaId:'business-owners'})).toMatchObject({sendEnabled:false,persona:{id:'business_owners',sharePercent:18,signals:expect.arrayContaining([expect.objectContaining({group:'Financial fit'})])}});
 expect(getOutreachFinalContent({section:'sequence',sequenceId:'H1_IT'})).toMatchObject({sequence:{id:'H1_IT',language:'it',sendEnabled:false}});
 expect(getOutreachFinalContent({section:'scoring',personaId:'pa_ea'})).toMatchObject({scoring:{displayFormula:'sum(commonScore)'},personaFactors:expect.arrayContaining([{name:'Travel responsibility',capPoints:40,sourceRule:expect.any(String),status:expect.any(String)}])});
 expect(()=>getOutreachFinalContent({section:'profile',personaId:'other-client'})).toThrow('FINAL_CONTENT_PERSONA_NOT_FOUND');
 expect(()=>getOutreachFinalContent({section:'sequence',sequenceId:'https://other.test'})).toThrow('FINAL_CONTENT_SEQUENCE_NOT_FOUND');
});
