'use strict';
// Compile the root payloads for the selected TV runtime.
// Default: .NET 6 payloads in payload/net6/.
// VETRO_TIZEN55=1: .NET Core 3.0 payloads in payload/ with .tizen55 filenames.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

const tizen55 = process.env.VETRO_TIZEN55 === '1';
const targetFramework = tizen55 ? 'netcoreapp3.0' : 'net6.0';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), tizen55 ? 'vetro-net30-' : 'vetro-net6-'));
const destination = tizen55 ? path.join(__dirname, 'payload') : path.join(__dirname, 'payload', 'net6');
const xml = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

try {
    for (const name of ['SamsungTvArchiveRoot', 'SamsungTvRootAgent']) {
        const directory = path.join(temporary, name);
        fs.mkdirSync(directory);
        const source = path.join(__dirname, 'tools', 'samsung-tv-root-master', 'payloads', 'common', name + '.cs');
        const project = path.join(directory, name + '.csproj');
        const projectText = [
            '<Project Sdk="Microsoft.NET.Sdk">',
            '  <PropertyGroup>',
            '    <TargetFramework>' + targetFramework + '</TargetFramework><OutputType>Exe</OutputType>',
            '    <AssemblyName>' + name + '</AssemblyName><UseAppHost>false</UseAppHost>',
            '    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>',
            '    <ImplicitUsings>disable</ImplicitUsings><Nullable>disable</Nullable>',
            '    <Deterministic>true</Deterministic><DebugType>none</DebugType>',
            '    <RollForward>LatestPatch</RollForward>',
            '  </PropertyGroup>',
            '  <ItemGroup><Compile Include="' + xml(source) + '" /></ItemGroup>',
            '</Project>'
        ].join('\n') + '\n';
        fs.writeFileSync(project, projectText);
        const output = path.join(directory, 'out');
        const result = spawnSync('dotnet', ['build', project, '-c', 'Release', '-o', output, '--nologo'],
            {cwd: temporary, stdio: 'inherit'});
        if (result.error) throw result.error;
        if (result.status !== 0) throw Error('Failed to build ' + name + ' for ' + targetFramework);
        fs.mkdirSync(destination, {recursive: true});
        for (const suffix of ['.dll', '.deps.json', '.runtimeconfig.json']) {
            const builtName = name + suffix;
            const targetName = tizen55 ? name + '.tizen55' + suffix : builtName;
            fs.copyFileSync(path.join(output, builtName), path.join(destination, targetName));
        }
    }
    console.log('Built ' + targetFramework + ' root payloads in ' + destination);
} finally {
    fs.rmSync(temporary, {recursive: true, force: true});
}
