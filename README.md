# Asesor de Portafolio (versión ligera — sin Next.js/Vercel)

Un único archivo `index.html` (como tu proyecto Vermonte/FutbolStock) + Supabase para todo lo demás:
autenticación, base de datos, storage de imágenes y las dos funciones que necesitan una clave secreta
(leer la imagen con IA, y pedir datos a Financial Modeling Prep). Sin build step, sin npm, sin Vercel.

## Por qué es más simple que la versión Next.js

| | Esta versión | Versión Next.js anterior |
|---|---|---|
| Frontend | 1 archivo `index.html` | Decenas de archivos, requiere `npm run build` |
| Hosting | GitHub Pages / Netlify drop / cualquier hosting estático (gratis) | Vercel |
| Backend | 2 Supabase Edge Functions (gratis) | Servidor Next.js completo |
| Multiusuario | Sí, con Supabase Auth (login/signup reales) | Sí |
| Seguridad de claves | GEMINI_API_KEY y FMP_API_KEY viven solo en Supabase, nunca en el navegador | Igual, en variables de entorno de Vercel |

## 1. Crear el proyecto de Supabase

1. Crea un proyecto gratis en https://supabase.com
2. **SQL Editor** → pega y ejecuta [`supabase/schema.sql`](./supabase/schema.sql).
3. **Storage** → crea un bucket llamado `portfolio-uploads`, **privado**.
4. En **Storage > Policies** del bucket, agrega (para `authenticated`):
   - SELECT: `(auth.uid())::text = (storage.foldername(name))[1]`
   - INSERT: `(auth.uid())::text = (storage.foldername(name))[1]`
5. **Authentication > Providers**: confirma que "Email" esté habilitado (viene por defecto). Si no quieres
   que pida confirmación por correo (más simple para partir), en **Authentication > Settings** desactiva
   "Confirm email".
6. **Settings > API**: copia el `Project URL` y la `anon public key`.

## 2. Completar el HTML

Abre `index.html` y edita estas dos líneas (busca "CONFIGURACIÓN" cerca del final del archivo):

```js
const SUPABASE_URL = "https://tu-proyecto.supabase.co";
const SUPABASE_ANON_KEY = "tu-anon-key";
```

Esa `anon key` es segura de dejar visible en el HTML — está diseñada para eso. La seguridad real la dan
las políticas RLS (ya incluidas en `schema.sql`), que garantizan que cada usuario solo vea sus propias
posiciones.

## 3. Instalar la CLI de Supabase y desplegar las Edge Functions

Necesitas Node/npx instalado (lo normal en cualquier Mac).

```bash
npx supabase login
cd supabase
npx supabase link --project-ref TU-PROJECT-REF   # está en la URL de tu proyecto: https://supabase.com/dashboard/project/TU-PROJECT-REF
npx supabase secrets set GEMINI_API_KEY=tu-gemini-key   # gratis en https://aistudio.google.com/apikey
npx supabase secrets set FMP_API_KEY=tu-fmp-key
npx supabase functions deploy parse-portfolio-image
npx supabase functions deploy market-data
```

Con esto, las dos funciones quedan corriendo gratis en la infraestructura de Supabase (plan gratuito
incluye 500,000 invocaciones/mes, de sobra para uso personal o de un grupo pequeño).

## 4. Probar localmente

Simplemente abre `index.html` haciendo doble clic, o sirve la carpeta con cualquier servidor estático:

```bash
npx serve .
```

Crea una cuenta, prueba subir una captura de tu portafolio.

## 5. Publicar gratis en GitHub Pages

```bash
git init
git add .
git commit -m "Asesor de portafolio"
git branch -M main
git remote add origin https://github.com/tu-usuario/asesor-portafolio.git
git push -u origin main
```

Luego en GitHub: **Settings > Pages** → Source: "Deploy from a branch" → Branch: `main` / `(root)` → Save.
En un par de minutos tu app queda disponible en `https://tu-usuario.github.io/asesor-portafolio/`.

Cualquier persona que entre a esa URL puede crear su cuenta y usar su propio portafolio — aislado del de
los demás por las políticas RLS de Supabase.

## Notas de seguridad y costos

- **Nunca pongas `GEMINI_API_KEY` ni `FMP_API_KEY` dentro de `index.html`** — solo la `anon key` de
  Supabase va ahí. Las otras dos viven exclusivamente como secretos de Supabase Edge Functions.
- **RLS activado en todas las tablas**: cada usuario solo puede leer/escribir sus propias filas en
  `positions` y `target_weights`. La tabla `market_cache` es de lectura/escritura compartida a propósito
  (son datos públicos de mercado, no información privada).
- **Costos**: Supabase (DB + Auth + Storage + Edge Functions) tiene plan gratuito generoso para este uso.
  Gemini (Google AI Studio) tiene un nivel gratuito (con límites de solicitudes por día, más que suficiente
  para uso personal). Financial Modeling Prep tiene plan gratuito con límite de requests/día — si creces
  mucho en usuarios, revisa si necesitas subir de plan.
- **DCF ilustrativo**: los supuestos de crecimiento/descuento son un punto de partida educativo, no una
  valoración profesional — la app lo deja explícito en cada ficha.
- Este proyecto es informativo, no reemplaza asesoría financiera profesional.
