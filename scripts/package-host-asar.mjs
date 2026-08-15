import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const [sourceArgument, destinationArgument, asarModuleArgument] = process.argv.slice(2);
if (!sourceArgument || !destinationArgument || !asarModuleArgument) {
  throw new Error("Usage: package-host-asar.mjs <source> <destination> <asar-module>");
}

const source = resolve(sourceArgument);
const destination = resolve(destinationArgument);
const asarModule = await import(pathToFileURL(resolve(asarModuleArgument)).href);
const ignoredRuntime = `${source}${sep}runtime${sep}**`;
const ignoredLauncher = `${source}${sep}start-host.ps1`;

await asarModule.createPackageWithOptions(source, destination, {
  globOptions: { ignore: [ignoredRuntime, ignoredLauncher] },
});
