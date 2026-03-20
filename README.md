# Bookyy

Bookyy es una web app estatica para registrar libros terminados y ver cuantas paginas lees por año.

## Funcionalidades

- Alta de libros con deteccion automatica de paginas (Open Library y Google Books)
- Carga manual de paginas cuando no se encuentran automaticamente
- Resumen anual (paginas totales y libros leidos)
- Lista de libros por año con opcion de borrar
- Sugerencias mientras escribes el titulo
- Recomendaciones de lectura basadas en tus libros
- Guardado local en el navegador (localStorage)

## Publicacion en GitHub Pages

Este repo incluye un workflow que publica automaticamente el contenido de `public/` en GitHub Pages cuando haces push a `main`.

### Pasos

1. Crea un repo vacio en GitHub, por ejemplo: `bookyy`.
2. En esta carpeta, ejecuta:

```bash
git init
git add .
git commit -m "feat: app estatica lista para pages"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git push -u origin main
```

3. En GitHub: Settings -> Pages, verifica que la fuente sea **GitHub Actions**.
4. Espera a que termine el workflow `Deploy static site to GitHub Pages`.
5. Tu app quedara disponible en la URL de Pages del repo.

## Nota sobre datos

Los libros se guardan en el navegador del usuario. No hay backend ni base de datos central.
