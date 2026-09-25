// Disposable transport probe. The installed product need not depend on .NET.
// Preserve Native Messaging framing verbatim between stdio and one private pipe.
using System.IO.Pipes;
using System.Text.Json;

var config = JsonSerializer.Deserialize<Dictionary<string, string>>(
    File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "bridge.json")))!;
if (args.Length == 0 || args[0] != config["origin"]) return 2;
using var pipe = new NamedPipeClientStream(".", config["pipe"], PipeDirection.InOut,
    PipeOptions.Asynchronous);
using var cancellation = new CancellationTokenSource();
await pipe.ConnectAsync(5000, cancellation.Token);
var fromBrowser = Console.OpenStandardInput().CopyToAsync(pipe, cancellation.Token);
var toBrowser = pipe.CopyToAsync(Console.OpenStandardOutput(), cancellation.Token);
await Task.WhenAny(fromBrowser, toBrowser);
await cancellation.CancelAsync();
return 0;
