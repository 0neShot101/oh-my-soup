yield cannot contain both data and error: received a non-placeholder error ({{{errorJson}}}).

Resubmit exactly one outcome:
- For success, resend the same payload without `error`, keeping the same `type` if you sent one: {{#if typeJson}}`{"type":{{{typeJson}}},"data":<your output>}`{{else}}`{"data":<your output>}`{{/if}}.
- For failure, resend only `{{{failureJson}}}`.
