import 'server-only';
import {loadInstallationConfig} from '@/config/installation';
import type {SignalConfig} from './website-signals';
export async function loadWebsiteSignalConfiguration():Promise<SignalConfig>{
 const installation=await loadInstallationConfig();
 return {enabled:process.env.AIBRAIN_WEBSITE_SIGNALS_ENABLED==='true',activationApproved:process.env.AIBRAIN_WEBSITE_SIGNALS_ACTIVATION_APPROVED==='true',installationId:installation.installationId,clientAccountReference:process.env.AIBRAIN_WEBSITE_SIGNALS_CLIENT_REFERENCE||'',signingKey:process.env.AIBRAIN_WEBSITE_SIGNALS_SIGNING_KEY||'',storageRoot:installation.paths.dataRoot,retentionDays:Number(process.env.AIBRAIN_WEBSITE_SIGNALS_RETENTION_DAYS||30)};
}
