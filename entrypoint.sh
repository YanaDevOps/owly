#!/bin/sh

echo "[+] Starting Owly ..."

exec ./owly \
  ${OWLY_CPUPROFILE:+-cpuprofile ${OWLY_CPUPROFILE}} \
  ${OWLY_DATA:+-data ${OWLY_DATA}} \
  ${OWLY_GROUPS:+-groups ${OWLY_GROUPS}} \
  ${OWLY_HTTP:+-http ${OWLY_HTTP}} \
  ${OWLY_INSECURE:+-insecure} \
  ${OWLY_MDNS:+-mdns} \
  ${OWLY_MEMPROFILE:+-memprofile ${OWLY_MEMPROFILE}} \
  ${OWLY_MUTEXPROFILE:+-mutexprofile ${OWLY_MUTEXPROFILE}} \
  ${OWLY_RECORDINGS:+-recordings ${OWLY_RECORDINGS}} \
  ${OWLY_NOCACHE:+-nocache} \
  ${OWLY_RELAY_ONLY:+-relay-only} \
  ${OWLY_STATIC:+-static ${OWLY_STATIC}} \
  ${OWLY_TURN+-turn ${OWLY_TURN:-''}}
