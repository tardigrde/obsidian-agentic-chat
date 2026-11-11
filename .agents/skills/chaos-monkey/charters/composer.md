Stress the chat composer and the turn lifecycle.

Send prompts that start tool calls, then while a turn runs: send more text (steer), stop the turn, send again at once, press Escape, switch session tabs, and open settings. Try empty input, whitespace, very long input, pasted markdown, slash commands with wrong arguments, unknown slash commands, and @-mentions of missing notes. Check that the composer never gets stuck, that queued text is not lost, and that the transcript stays in order.
