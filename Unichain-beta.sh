#!/bin/bash

exists() {
  command -v "$1" >/dev/null 2>&1
}

show() {
  case $2 in
    "error") echo -e "${PINK}${BOLD}❌ $1${NORMAL}" ;;
    "progress") echo -e "${PINK}${BOLD}⏳ $1${NORMAL}" ;;
    *) echo -e "${PINK}${BOLD}✅ $1${NORMAL}" ;;
  esac
}

BOLD=$(tput bold)
NORMAL=$(tput sgr0)
PINK='\033[1;35m'

if ! exists curl; then
  show "curl not found. Installing..." "error"
  sudo apt update && sudo apt install curl -y < "/dev/null"
else
  show "curl is already installed."
fi

bash_profile="$HOME/.bash_profile"
[ -f "$bash_profile" ] && show "Sourcing .bash_profile..." && . "$bash_profile"

clear
show "Fetching and running logo script..." "progress"
sleep 2
curl -s https://raw.githubusercontent.com/zidanaetrna/unichain/refs/heads/main/button_logo_script.sh | bash

show "Starting Deploy Unichain..." "progress"
sleep 2

set -eo pipefail

if [ -d "unichain" ]; then
  rm -rf unichain
  show "Removed existing unichain folder." "done"
fi

show "Installing foundryup..." "progress"
BASE_DIR="${XDG_CONFIG_HOME:-$HOME}"
FOUNDRY_DIR="${FOUNDRY_DIR-"$BASE_DIR/.foundry"}"
FOUNDRY_BIN_DIR="$FOUNDRY_DIR/bin"
FOUNDRY_MAN_DIR="$FOUNDRY_DIR/share/man/man1"

mkdir -p "$FOUNDRY_BIN_DIR"
curl -sSf -L https://raw.githubusercontent.com/foundry-rs/foundry/master/foundryup/foundryup -o "$FOUNDRY_BIN_DIR/foundryup"
chmod +x "$FOUNDRY_BIN_DIR/foundryup"

mkdir -p "$FOUNDRY_MAN_DIR"
show "Configuring shell profile..." "progress"

case $SHELL in
  */zsh) PROFILE="${ZDOTDIR-"$HOME"}/.zshenv" ;;
  */bash) PROFILE="$HOME/.bashrc" ;;
  */fish) PROFILE="$HOME/.config/fish/config.fish" ;;
  */ash) PROFILE="$HOME/.profile" ;;
  *) show "Shell not detected. Please add ${FOUNDRY_BIN_DIR} to your PATH manually." "error" && exit 1 ;;
esac

if [[ ":$PATH:" != *":${FOUNDRY_BIN_DIR}:"* ]]; then
    if [[ "$SHELL" == *fish* ]]; then
        echo "fish_add_path -a $FOUNDRY_BIN_DIR" >> "$PROFILE"
    else
        echo "export PATH=\"\$PATH:$FOUNDRY_BIN_DIR\"" >> "$PROFILE"
    fi
fi

export PATH="$FOUNDRY_BIN_DIR:$PATH"
show "Foundryup installed successfully."
foundryup

show "Setting up Unichain and OpenZeppelin..." "progress"
mkdir -p unichain && cd unichain

echo "Choose an option:"
echo "1) Deploy ERC20 Token only"
echo "2) Deploy NFT only"
echo "3) Deploy both ERC20 Token and NFT"
read -p "Enter your choice (1, 2, or 3): " CHOICE

deploy_erc20() {
  mkdir -p winsnip
  cat <<EOF > foundry.toml
[rpc_endpoints]
unichain = "https://sepolia.unichain.org"
EOF

  if [ ! -d "./openzeppelin" ]; then
      show "Cloning OpenZeppelin contracts..." "progress"
      git clone https://github.com/OpenZeppelin/openzeppelin-contracts.git lib/openzeppelin-contracts
  fi

  read -p "Contract name: " CONTRACT_NAME
  read -p "Token name: " TOKEN_NAME
  read -p "Token symbol: " TOKEN_SYMBOL
  read -p "Initial supply (tokens): " INITIAL_SUPPLY
  read -p "Your Ethereum address: " YOUR_ADDRESS
  read -p "Your private key: " YOUR_PRIVATE_KEY

  show "Creating ERC20 contract file..." "progress"
  cat <<EOF > winsnip/$CONTRACT_NAME.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import "lib/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "lib/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import "lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import "lib/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC20Permit.sol";

contract $CONTRACT_NAME is ERC20, ERC20Burnable, ERC20Pausable, Ownable, ERC20Permit {
    constructor(address initialOwner) 
        ERC20("$TOKEN_NAME", "$TOKEN_SYMBOL") 
        Ownable(initialOwner) 
        ERC20Permit("$TOKEN_NAME") 
    {
        _mint(msg.sender, $INITIAL_SUPPLY * 10 ** decimals());
    }

    function pause() public onlyOwner {
        _pause();
    }

    function unpause() public onlyOwner {
        _unpause();
    }

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Pausable) {
        super._update(from, to, value);
    }
}
EOF

  show "Deploying ERC20 contract..." "progress"
  DEPLOY_CMD="forge create winsnip/$CONTRACT_NAME.sol:$CONTRACT_NAME --constructor-args $YOUR_ADDRESS --rpc-url unichain --private-key $YOUR_PRIVATE_KEY"
  eval $DEPLOY_CMD

  read -p "Deployed ERC20 contract address: " CONTRACT_ADDRESS
  show "Token contract can be viewed at: https://sepolia.uniscan.xyz/token/$CONTRACT_ADDRESS" "done"

  show "Sending tokens to random addresses..." "progress"
  read -p "How many random addresses to send tokens to: " NUM_ADDRESSES

  generate_random_address() {
      echo "0x$(openssl rand -hex 20)"
  }

  PERCENTAGE_AMOUNT=$((INITIAL_SUPPLY / 100))
  MIN_AMOUNT=1
  for ((i=0; i<NUM_ADDRESSES; i++)); do
      RANDOM_ADDRESS=$(generate_random_address)
      RANDOM_UNIT=$((RANDOM % 1 + MIN_AMOUNT))  
      AMOUNT_TO_SEND=$((PERCENTAGE_AMOUNT + RANDOM_UNIT))

      if [[ AMOUNT_TO_SEND -lt 0 ]]; then
          AMOUNT_TO_SEND=0
      fi

      AMOUNT_WEI=$((AMOUNT_TO_SEND * 10 ** 18))

      SEND_CMD="cast send \"$CONTRACT_ADDRESS\" \"transfer(address,uint256)\" \"$RANDOM_ADDRESS\" \"$AMOUNT_WEI\" --rpc-url unichain --private-key \"$YOUR_PRIVATE_KEY\""
      echo "Executing command: $SEND_CMD"

      if ! eval "$SEND_CMD"; then
          echo "Error sending tokens to $RANDOM_ADDRESS"
      fi
  done
  show "https://sepolia.uniscan.xyz/address/$YOUR_ADDRESS#tokentxns" "done"
  show "All tokens sent successfully." "done"
}

deploy_nft() {
  mkdir -p winsnip
  read -p "Enter the name of the NFT: " NFT_NAME
  read -p "Enter the symbol of the NFT: " NFT_SYMBOL
  read -p "Enter your private key: " YOUR_PRIVATE_KEY  
  read -p "Enter the owner address for the NFT contract: " OWNER_ADDRESS  

  if [ ! -d "./lib/openzeppelin-contracts" ]; then
      show "Cloning OpenZeppelin contracts..." "progress"
      git clone https://github.com/OpenZeppelin/openzeppelin-contracts.git lib/openzeppelin-contracts
  fi

  cat <<EOF > foundry.toml
[rpc_endpoints]
unichain = "https://sepolia.unichain.org"
EOF

  cat <<EOF > winsnip/MyNFT.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "lib/openzeppelin-contracts/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "lib/openzeppelin-contracts/contracts/access/Ownable.sol";

contract MyNFT is ERC721URIStorage, Ownable {
    uint256 private _tokenIdCounter;

    constructor(address initialOwner) ERC721("$NFT_NAME", "$NFT_SYMBOL") Ownable(initialOwner) {
        transferOwnership(initialOwner);
    }

    function safeMint(address to, string memory uri) public onlyOwner {
        uint256 tokenId = _tokenIdCounter;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);
        _tokenIdCounter++;
    }
}
EOF

  show "Deploying NFT contract..." "progress"
  DEPLOY_CMD="forge create winsnip/MyNFT.sol:MyNFT --rpc-url https://sepolia.unichain.org --private-key $YOUR_PRIVATE_KEY --constructor-args $OWNER_ADDRESS"
  eval $DEPLOY_CMD

  read -p "Enter deployed NFT contract address: " NFT_CONTRACT_ADDRESS

  show "Minting NFTs..." "progress"
  read -p "How many NFTs to mint: " NUM_NFTS

    OWNER_MINT_COUNT=$((NUM_NFTS / 10))
    RANDOM_MINT_COUNT=$((NUM_NFTS - OWNER_MINT_COUNT))

    read -p "Enter base Token URI (e.g., https://lc2rtjgzig.execute-api.eu-west-1.amazonaws.com/prod/metadata/): " BASE_URI

    for ((i=0; i<OWNER_MINT_COUNT; i++)); do
        TOKEN_URI="${BASE_URI}+${i}"
        MINT_CMD="cast send \"$NFT_CONTRACT_ADDRESS\" \"safeMint(address,string)\" \"$OWNER_ADDRESS\" \"$TOKEN_URI\" --rpc-url https://sepolia.unichain.org --private-key \"$YOUR_PRIVATE_KEY\""
        eval $MINT_CMD
    done

    for ((i=0; i<RANDOM_MINT_COUNT; i++)); do
        TOKEN_URI="${BASE_URI}+$(($OWNER_MINT_COUNT + i))"
        RANDOM_ADDRESS=$(openssl rand -hex 20)
        MINT_CMD="cast send \"$NFT_CONTRACT_ADDRESS\" \"safeMint(address,string)\" \"$RANDOM_ADDRESS\" \"$TOKEN_URI\" --rpc-url https://sepolia.unichain.org --private-key \"$YOUR_PRIVATE_KEY\""
        eval $MINT_CMD
    done
  show "NFT contract can be viewed at: https://sepolia.uniscan.xyz/token/$NFT_CONTRACT_ADDRESS" "done"
  show "All NFTs minted successfully." "done"
}

case $CHOICE in
  1) deploy_erc20 ;;
  2) deploy_nft ;;
  3) 
    deploy_erc20
    deploy_nft
    ;;
  *) 
    show "Invalid choice. Please enter 1, 2, or 3." "error"
    exit 1
    ;;
esac
