import {it,expect} from 'vitest';
import {outreachMessageText} from '../../src/insijets/outreach-message-text';
it('makes actual provider HTML copy readable while keeping all markup inert',()=>{
 expect(outreachMessageText('<div>Hello&nbsp;{{firstName}},</div><div><br></div><p>Routes &amp; schedules.</p><script>fetch("https://bad.test")</script><img src="https://tracker.test/pixel">')).toBe('Hello {{firstName}},\n\nRoutes & schedules.');
 expect(outreachMessageText('Plain body\nSecond line')).toBe('Plain body\nSecond line');
 expect(outreachMessageText('&lt;img src=x onerror=alert(1)&gt; &#x1f680; &#99999999;')).toBe('<img src=x onerror=alert(1)> 🚀 �');
});
