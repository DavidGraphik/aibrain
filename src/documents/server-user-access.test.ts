import { describe, it, expect } from 'vitest';
import { serverPathAllowed, serverUserRoots } from './server-user-access';
describe('G03 employee folder boundary',()=>{
 const roots=['server-g03/M/G03/QUALITAT','server-g03/M/G03/PLANOLS'];
 it('allows only exact roots and descendants, with navigable ancestors',()=>{expect(serverPathAllowed('server-g03/M/G03/QUALITAT/Equip%20A.pdf',roots)).toBe(true);expect(serverPathAllowed('server-g03/M/G03',roots,true)).toBe(true);expect(serverPathAllowed('server-g03/M/G03',roots)).toBe(false);expect(serverPathAllowed('server-g03/M/G03/ADMINISTRACIO/payroll.pdf',roots)).toBe(false);expect(serverPathAllowed('server-g03/M/G03/QUALITAT-PRIVATE/file',roots)).toBe(false);expect(serverPathAllowed('server-g03/M/G03/QUALITAT/%2e%2e/ADMINISTRACIO/file',roots)).toBe(false);});
 it('fails closed without an authenticated G03 user, leaving other installations unchanged',async()=>{expect(await serverUserRoots('g03-production','/missing')).toEqual([]);expect(await serverUserRoots('other','/missing')).toBeNull();});
});
