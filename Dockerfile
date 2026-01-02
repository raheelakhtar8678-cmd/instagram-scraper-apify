# Specify the base Docker image.
# We use actor-node-playwright-chrome to ensure all browser binaries
# and system dependencies are included.
FROM apify/actor-node-playwright-chrome:20

# Copy just package.json and package-lock.json
# to speed up the build using Docker layer cache.
COPY package*.json ./

# Install NPM packages, skip optional and development dependencies to
# keep the image small.
RUN npm install --omit=dev --omit=optional

# Next, copy the remaining files and directories with the source code.
# Since we do this after NPM install, quick build will be really fast
# for most source file changes.
COPY . ./

# Run the image.
CMD npm start
