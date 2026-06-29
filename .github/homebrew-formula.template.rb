class Deployhub < Formula
  desc "Zero-configuration deployment and artifact manager"
  homepage "https://github.com/Akash-Chowdhury-24/DeployHub"
  version "VERSION_PLACEHOLDER"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/Akash-Chowdhury-24/DeployHub/releases/download/vVERSION_PLACEHOLDER/deployhub-macos-arm64"
      sha256 "MACOS_ARM_SHA_PLACEHOLDER"
    else
      url "https://github.com/Akash-Chowdhury-24/DeployHub/releases/download/vVERSION_PLACEHOLDER/deployhub-macos-x64"
      sha256 "MACOS_SHA_PLACEHOLDER"
    end
  end

  on_linux do
    url "https://github.com/Akash-Chowdhury-24/DeployHub/releases/download/vVERSION_PLACEHOLDER/deployhub-linux-x64"
    sha256 "LINUX_SHA_PLACEHOLDER"
  end

  def install
    if OS.mac? && Hardware::CPU.arm?
      bin.install "deployhub-macos-arm64" => "deployhub"
    elsif OS.mac?
      bin.install "deployhub-macos-x64" => "deployhub"
    else
      bin.install "deployhub-linux-x64" => "deployhub"
    end
  end

  test do
    system "#{bin}/deployhub", "--version"
  end
end
