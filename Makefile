build-BatchApi:
	dotnet publish api/CratePending.csproj -c Release -o "$(ARTIFACTS_DIR)"
