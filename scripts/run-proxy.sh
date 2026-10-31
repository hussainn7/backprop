#!/usr/bin/env bash
# Usage: run-proxy.sh public|bots
cd "/home/hussain/minecraft-server/proxy-$1" || exit 1
exec /home/hussain/minecraft-server/runtime/java/bin/java -Xms64M -Xmx160M -XX:+UseG1GC -jar /home/hussain/minecraft-server/runtime/velocity.jar
