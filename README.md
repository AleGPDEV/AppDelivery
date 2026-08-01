# Optimizador de Rutas de Delivery

App web (sin instalación, sin backend) para armar la ruta más eficiente de un delivery a partir de una lista de pedidos.

## Uso

1. Abrí `index.html` en el navegador (o la URL de GitHub Pages, si está activada).
2. Cargá el **punto de partida** (coordenadas, link de Google Maps o dirección).
3. Pegá los **pedidos**, uno por línea, en el formato:

   ```
   99   https://www.google.com/maps?q=-34.7599,-56.0083
   3    https://www.google.com/maps?q=-34.7067,-55.9607
   6    Complejo Palmas del Norte, Ruta 75, Pando, Uruguay
   ```

   El número de pedido y la ubicación pueden ir separados por tabulación, coma o espacio (se puede pegar directo desde una planilla).
4. Presioná **Calcular ruta óptima**. La app:
   - Convierte direcciones de texto a coordenadas (Nominatim/OpenStreetMap).
   - Calcula el orden más eficiente usando distancias reales de manejo (OSRM).
   - Dibuja el recorrido en el mapa siguiendo las calles.
   - Genera un link de **Google Maps** listo para abrir en el celular del delivery.

## Notas técnicas

- 100% del lado del cliente: no requiere servidor propio ni API keys.
- Usa los servidores públicos y gratuitos de [Nominatim](https://nominatim.org/) (geocodificación) y [OSRM](http://project-osrm.org/) (ruteo). Son aptos para uso liviano/prototipo; para volumen alto en producción conviene self-hostearlos.
- Si el servicio de rutas no responde, la app avisa y usa una estimación en línea recta como respaldo.
- Google Maps admite hasta 23 paradas intermedias por recorrido.
