#!/bin/sh
# Builds the dock and copies the two files the Vetro package needs into app/native/dock/.
# The images come straight from dock/res when the package is built (app/build.cjs).
set -e
cd "$(dirname "$0")"
if [ "${VETRO_TIZEN55:-0}" = "1" ]; then
    FRAMEWORK=netcoreapp3.0
    dotnet build -c Release Launcher.csproj -p:VETRO_TIZEN55=true
else
    FRAMEWORK=netcoreapp3.1
    dotnet build -c Release Launcher.csproj
fi
cp "bin/Release/$FRAMEWORK/tvlauncher-dotnet.dll" "bin/Release/$FRAMEWORK/tvlauncher-dotnet.runtimeconfig.json" ../app/native/dock/
echo "copied to app/native/dock/"
