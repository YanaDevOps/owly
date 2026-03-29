.PHONY: all build blur clean help

# Variables
BINARY := owly
GOFLAGS := -trimpath -ldflags='-s -w'
STATIC_DIR := static/third-party/tasks-vision
MODELS_DIR := $(STATIC_DIR)/models
MEDIAPIPE_VERSION := 0.10.34
MEDIAPIPE_TARBALL_URL := https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-$(MEDIAPIPE_VERSION).tgz
MEDIAPIPE_TARBALL_SHA256 := 074761536391855d89edbc6d8e811de0dee99cba8c2b6b5c0167250f11755979
MEDIAPIPE_MODEL_URL := https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite?generation=1683436453600523
MEDIAPIPE_MODEL_SHA256 := 191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b

# Build targets
all: build blur

# Build Owly binary (optimized, stripped)
build:
	@echo "Building $(BINARY)..."
	CGO_ENABLED=0 go build $(GOFLAGS) -o $(BINARY)
	@echo "✓ Built: ./$(BINARY)"

# Install MediaPipe library for background blur
blur:
	@echo "Installing MediaPipe for background blur..."
	@mkdir -p $(MODELS_DIR)
	@tmp=$$(mktemp -d) && \
		trap 'rm -rf "$$tmp"' EXIT && \
		curl -fsSL "$(MEDIAPIPE_TARBALL_URL)" -o "$$tmp/tasks-vision.tgz" && \
		printf '%s  %s\n' "$(MEDIAPIPE_TARBALL_SHA256)" "$$tmp/tasks-vision.tgz" | sha256sum -c - >/dev/null && \
		tar xzf "$$tmp/tasks-vision.tgz" -C "$$tmp" && \
		rm -rf $(abspath $(STATIC_DIR)) && \
		mv "$$tmp/package" $(abspath $(STATIC_DIR))
	@mkdir -p $(MODELS_DIR)
	@tmp_model=$$(mktemp) && \
		trap 'rm -f "$$tmp_model"' EXIT && \
		curl -fsSL "$(MEDIAPIPE_MODEL_URL)" -o "$$tmp_model" && \
		printf '%s  %s\n' "$(MEDIAPIPE_MODEL_SHA256)" "$$tmp_model" | sha256sum -c - >/dev/null && \
		mv "$$tmp_model" "$(MODELS_DIR)/selfie_segmenter.tflite"
	@echo "✓ Background blur enabled"

# Clean build artifacts
clean:
	@rm -rf $(BINARY) mediapipe
	@echo "✓ Cleaned"

help:
	@echo "Owly Makefile"
	@echo ""
	@echo "  make build   - Build optimized binary"
	@echo "  make blur    - Install background blur (MediaPipe)"
	@echo "  make all     - Build with blur enabled (default)"
	@echo "  make clean   - Remove build artifacts"
