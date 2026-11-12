# Bundled Layers demo

The upstream LayersStudio original sample URL returned HTTP 403 AccessDenied:
https://cdn.muapi.ai/assets/1786019968051_cKRYLHHu.png

The five still-public layer cutouts from the same upstream demonstration were
bundled and placed on a shared 1080px canvas to restore a working editor demo.
The sample composite is rebuilt from these layers, not the unavailable original.
Sources, in upstream order:
- https://cdn.muapi.ai/assets/1786021161819_iOe80bNR.webp
- https://cdn.muapi.ai/assets/1786020452731_mB4m6NFR.webp
- https://cdn.muapi.ai/assets/1786021169234_iyVccSAA.webp
- https://cdn.muapi.ai/assets/1786021154170_Dx9snemT.webp
- https://cdn.muapi.ai/assets/1786021150882_p9lgz4lY.webp

Local sample media is uploaded via the existing authenticated provider upload
flow before an AI operation; the provider cannot fetch OTP-protected app assets.
