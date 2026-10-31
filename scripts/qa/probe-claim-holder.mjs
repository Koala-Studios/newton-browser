// Claims one new tab and waits to be killed.
const [candidate, advertisement] = process.argv.slice(2);
const { connectNative } = await import(candidate);
const client = await connectNative(advertisement);
const token = await client.call('create_tab', {});
process.send(token);
setInterval(() => undefined, 1000);
