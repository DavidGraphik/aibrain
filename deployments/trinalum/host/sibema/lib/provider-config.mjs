// Protected installation configuration only. Neither the model nor provider data
// can select a different origin or company namespace for an operation.
const value=process.env.AIBRAIN_SIBEMA_ORIGIN||'https://erp.example.invalid';
const parsed=new URL(value);
if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw Error('SIBEMA_ORIGIN_INVALID');
export const sibemaOrigin=parsed.origin;
export const sibemaNamespace=process.env.SIBEMA_API_NAMESPACE||'company';
if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(sibemaNamespace))throw Error('SIBEMA_NAMESPACE_INVALID');
export const sibemaContractPrefix=`/${sibemaNamespace}/api/v1`;
export const sibemaApiBase=`${sibemaOrigin}/ERPBerma${sibemaContractPrefix}`;
