import {it,expect} from 'vitest';
import {outreachProviderConnections} from '../../src/insijets/outreach-provider-connection-status';
it('shows all client account tasks and never promotes token presence to a verified connection',()=>{
 const empty=outreachProviderConnections({});expect(empty.items.map(i=>i.provider)).toEqual(['apollo','prospeo','clay']);expect(empty.items.every(i=>i.status==='awaiting-client-account')).toBe(true);
 const configured=outreachProviderConnections({AIBRAIN_INSIJETS_APOLLO_API_KEY:'secret-fixture-value',AIBRAIN_INSIJETS_OUTREACH_PROVIDER_BINDINGS_FILE:'/private/client-bound.json'});
 expect(configured.items[0]).toMatchObject({credentialPresent:true,bindingReferencePresent:true,clientOwnedBindingVerified:false,executionAllowed:false,status:'configuration-review-required'});
 expect(JSON.stringify(configured)).not.toContain('secret-fixture-value');expect(JSON.stringify(configured)).not.toContain('/private/client-bound.json');expect(configured.realLookupEnabled).toBe(false);
});
