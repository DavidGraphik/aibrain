import {beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
const mocks=vi.hoisted(()=>({config:vi.fn(),configure:vi.fn(),enroll:vi.fn(),status:vi.fn(),revoke:vi.fn()}));
vi.mock('@/config/installation',()=>({loadInstallationConfig:mocks.config}));
vi.mock('./outlook-desktop-service',()=>({configureOutlookArchiveForIdentity:mocks.configure,createOutlookDesktopEnrollment:mocks.enroll,readOutlookDesktopStatusForIdentity:mocks.status,revokeOutlookDesktopIdentity:mocks.revoke}));
import {manageOutlookDesktop,parseOutlookDesktopOperatorArgs} from '../../scripts/manage-outlook-desktop';
const userId='11111111-1111-4111-8111-111111111111';
const maximum=20*1024**3;
const flags=(action='archive-configure')=>['--action',action,'--user-id',userId];
beforeEach(()=>{vi.clearAllMocks();mocks.config.mockResolvedValue({installationId:'g03-production'});mocks.configure.mockResolvedValue({configured:true});});
describe('trusted Outlook archive capacity operator',()=>{
  it.each([undefined,'','-1','1.5','1e3','NaN','Infinity',' 1','1 ','+1',String(maximum+1),'9007199254740993'])('rejects a missing or invalid archive quota %s before loading server configuration',async quota=>{
    const args=quota===undefined?flags():[...flags(),'--quota-bytes',quota];
    expect(()=>parseOutlookDesktopOperatorArgs(args)).toThrow('OUTLOOK_DESKTOP_CLI_ARGUMENTS_INVALID');
    await expect(manageOutlookDesktop(args)).rejects.toMatchObject({code:'OUTLOOK_DESKTOP_CLI_ARGUMENTS_INVALID'});
    expect(mocks.config).not.toHaveBeenCalled();expect(mocks.configure).not.toHaveBeenCalled();
  });
  it.each(['status','revoke','enroll'])('rejects quota on the unrelated %s action',async action=>{
    const args=[...flags(action),'--quota-bytes','0'];
    await expect(manageOutlookDesktop(args)).rejects.toMatchObject({code:'OUTLOOK_DESKTOP_CLI_ARGUMENTS_INVALID'});
    expect(mocks.config).not.toHaveBeenCalled();expect(mocks.configure).not.toHaveBeenCalled();expect(mocks.status).not.toHaveBeenCalled();expect(mocks.revoke).not.toHaveBeenCalled();expect(mocks.enroll).not.toHaveBeenCalled();
  });
  it.each([0,1,maximum])('forwards the exact reviewed quota %s to the current canonical user service only',async quota=>{
    const args=[...flags(),'--quota-bytes',String(quota)];
    expect(parseOutlookDesktopOperatorArgs(args)).toMatchObject({action:'archive-configure',userId,quotaBytes:quota});
    expect(await manageOutlookDesktop(args)).toEqual({configured:true});
    expect(mocks.configure).toHaveBeenCalledExactlyOnceWith({config:{installationId:'g03-production'},userId},quota);
    expect(mocks.status).not.toHaveBeenCalled();expect(mocks.revoke).not.toHaveBeenCalled();expect(mocks.enroll).not.toHaveBeenCalled();
  });
  it.each([
    ['--quota-bytes','1','--quota-bytes','2'],
    ['--quota-bytes','1','--store-id','foreign-store'],
    ['--quota-bytes','1','--email','foreign@example.test'],
    ['--quota-bytes','1','--inventory','/tmp/inventory.json'],
    ['--quota-bytes','1','--server-url','https://foreign.example.test'],
  ])('rejects duplicate capacity or enrollment-only overrides %j',async suffix=>{
    await expect(manageOutlookDesktop([...flags(),...suffix])).rejects.toMatchObject({code:'OUTLOOK_DESKTOP_CLI_ARGUMENTS_INVALID'});
    expect(mocks.config).not.toHaveBeenCalled();expect(mocks.configure).not.toHaveBeenCalled();
  });
});
