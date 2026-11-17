FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY api/ api/
COPY contracts/ contracts/
RUN dotnet publish api/CratePending.csproj -c Release -o /publish
FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /publish/ ./
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "CratePending.dll"]
