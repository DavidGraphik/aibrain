import {describe,it,expect,vi,beforeEach} from 'vitest';
const mocks=vi.hoisted(()=>({entry:vi.fn(),notFound:vi.fn(()=>{throw Error('NOT_FOUND');}),redirect:vi.fn(()=>{throw Error('REDIRECT');})}));
vi.mock('@/insijets/outreach-system-server',()=>({loadOutreachSystemEntry:mocks.entry}));
vi.mock('next/navigation',()=>({notFound:mocks.notFound,redirect:mocks.redirect}));
import OutreachSystemPage from '@/app/outreach/system/page';
describe('Old Outreach bookmark entry',()=>{
 beforeEach(()=>vi.clearAllMocks());
 it('opens the embedded workspace for an eligible session',async()=>{mocks.entry.mockResolvedValue({session:{},config:{}});await expect(OutreachSystemPage()).rejects.toThrow('REDIRECT');expect(mocks.redirect).toHaveBeenCalledWith('/?workspace=outreach');});
 it('does not redirect an unauthorised session into the workspace',async()=>{mocks.entry.mockResolvedValue(null);await expect(OutreachSystemPage()).rejects.toThrow('NOT_FOUND');expect(mocks.redirect).not.toHaveBeenCalled();});
});
