# The Canton node, from the same Daml SDK release the contracts are built and tested with.
FROM digitalasset/daml-sdk:3.4.0-rc2 AS sdk

FROM eclipse-temurin:21-jre
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
COPY --from=sdk /home/daml/.daml/sdk/3.4.0-rc2/canton/canton.jar /canton/canton.jar
COPY node.conf node.canton start.sh /canton/
EXPOSE 6865 6866 7575
CMD ["/canton/start.sh"]
