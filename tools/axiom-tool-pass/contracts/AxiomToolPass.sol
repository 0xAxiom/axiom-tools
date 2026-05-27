// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice Optional swappable on-chain renderer. When set, tokenURI() delegates
/// here; otherwise the contract falls back to baseURI + tokenId.
interface IAxiomPassRenderer {
    function tokenURI(uint256 tokenId) external view returns (string memory);
}

/// @notice ERC-8257 access predicate interfaces (interface IDs taken from the
/// draft EIP — verify on the registry before mainnet integration).
interface IAccessPredicate is IERC165 {
    function hasAccess(address user) external view returns (bool granted);
    function tryHasAccess(address user) external view returns (bool ok, bool granted);
}

interface IERC721Holding is IAccessPredicate {
    function token() external view returns (address);
    function minimumBalance() external view returns (uint256);
}

/// @title AXIOM Tool Pass
/// @notice 1000-supply ERC-721 on Base. Holding one pass grants lifetime
///         access to x402-paywalled AXIOM endpoints — gating is performed via
///         ERC-8257 (this contract self-attests as an IERC721Holding access
///         predicate, so the same address can be set as the `accessPredicate`
///         when registering a tool in the ERC-8257 registry on Base
///         (0x265B…2cf1)).
/// @dev    Mint mechanics: 0.005 ETH per pass, max 10 per wallet, hard cap 1000.
///         Funds forward to the treasury on each mint (no escrow). Pausable +
///         Ownable for emergency stop and admin operations only.
contract AxiomToolPass is ERC721Enumerable, Ownable, Pausable, ReentrancyGuard, IERC721Holding {
    using Strings for uint256;

    // -------------------------------------------------------------------
    //  Mint parameters — fixed at deploy time. None of these can be
    //  changed by the owner.
    // -------------------------------------------------------------------
    uint256 public constant MAX_SUPPLY = 1000;
    uint256 public constant MINT_PRICE = 0.005 ether;
    uint256 public constant MAX_PER_WALLET = 10;

    /// @notice Treasury that receives mint proceeds. Owner can rotate (e.g.
    ///         migrate from EOA to a Safe). Funds are forwarded synchronously
    ///         on every mint, so a rotation only affects future mints.
    address payable public treasury;

    /// @notice Seed used by the off-chain (and eventual on-chain) renderer to
    ///         derive deterministic per-token traits. Immutable so the trait
    ///         distribution can never be regenerated to favor specific tokens.
    bytes32 public immutable seedSalt;

    /// @notice Fallback base URI used when no renderer contract is set. The
    ///         off-chain endpoint at this URL must accept `<id>.json` and
    ///         return OpenSea-compliant metadata derived from `seedSalt`.
    string public baseURI;

    /// @notice Optional on-chain renderer. When non-zero, takes precedence
    ///         over `baseURI`. Allows a clean migration from off-chain to
    ///         fully on-chain SVG once the renderer is ported to Solidity.
    IAxiomPassRenderer public renderer;

    /// @notice Per-wallet mint counter. Enforces MAX_PER_WALLET across all
    ///         transactions from the same address (not just per-tx).
    mapping(address => uint256) public mintedPerWallet;

    /// @dev Token IDs start at 1 — matches the off-chain renderer mockups
    ///      and gives `0` a meaningful "no such token" sentinel.
    uint256 private _nextTokenId = 1;

    // -------------------------------------------------------------------
    //  Events
    // -------------------------------------------------------------------
    event Minted(address indexed minter, uint256 quantity, uint256 firstTokenId, uint256 paid);
    event TreasuryUpdated(address indexed previous, address indexed current);
    event BaseURIUpdated(string previous, string current);
    event RendererUpdated(address indexed previous, address indexed current);

    // -------------------------------------------------------------------
    //  Errors
    // -------------------------------------------------------------------
    error InvalidQuantity();
    error WalletLimitExceeded();
    error SupplyCapReached();
    error IncorrectPayment();
    error ZeroAddress();
    error TransferFailed();

    constructor(
        address initialOwner,
        address payable treasury_,
        bytes32 seedSalt_,
        string memory baseURI_
    ) ERC721("AXIOM Tool Pass", "AXTP") Ownable(initialOwner) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        seedSalt = seedSalt_;
        baseURI = baseURI_;
    }

    // -------------------------------------------------------------------
    //  Mint
    // -------------------------------------------------------------------

    /// @notice Mint `quantity` passes to the caller. Pays MINT_PRICE per pass
    ///         in ETH; funds forward to the treasury atomically.
    /// @dev    Reverts on: zero quantity, exceeding per-wallet cap, exceeding
    ///         total supply, or incorrect msg.value. Paused contracts revert.
    function mint(uint256 quantity) external payable whenNotPaused nonReentrant {
        if (quantity == 0) revert InvalidQuantity();
        if (mintedPerWallet[msg.sender] + quantity > MAX_PER_WALLET) revert WalletLimitExceeded();
        if (_nextTokenId - 1 + quantity > MAX_SUPPLY) revert SupplyCapReached();
        if (msg.value != quantity * MINT_PRICE) revert IncorrectPayment();

        mintedPerWallet[msg.sender] += quantity;
        uint256 firstTokenId = _nextTokenId;
        for (uint256 i = 0; i < quantity; i++) {
            _safeMint(msg.sender, _nextTokenId);
            unchecked { _nextTokenId++; }
        }

        emit Minted(msg.sender, quantity, firstTokenId, msg.value);

        // Forward proceeds to treasury. Address.sendValue reverts on failure
        // so we don't need a separate revert path.
        Address.sendValue(treasury, msg.value);
    }

    /// @notice Convenience view: how many of the 1000 are still mintable.
    function remainingSupply() external view returns (uint256) {
        return MAX_SUPPLY - (_nextTokenId - 1);
    }

    /// @notice Convenience view: how many a given wallet can still mint.
    function remainingForWallet(address wallet) external view returns (uint256) {
        uint256 used = mintedPerWallet[wallet];
        return used >= MAX_PER_WALLET ? 0 : MAX_PER_WALLET - used;
    }

    /// @notice Total minted so far (also equals next-token-id minus one).
    function totalMinted() external view returns (uint256) {
        return _nextTokenId - 1;
    }

    // -------------------------------------------------------------------
    //  Metadata
    // -------------------------------------------------------------------

    /// @inheritdoc ERC721
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        if (address(renderer) != address(0)) {
            return renderer.tokenURI(tokenId);
        }
        return string(abi.encodePacked(baseURI, tokenId.toString(), ".json"));
    }

    // -------------------------------------------------------------------
    //  ERC-8257 access predicate (IERC721Holding)
    //
    //  The Pass contract self-attests as the access predicate for tools
    //  gated on holding one of its NFTs. Tool registrations on the ERC-8257
    //  registry (Base 0x265B…2cf1) should set `accessPredicate` to this
    //  address. No separate predicate deployment needed.
    // -------------------------------------------------------------------

    /// @inheritdoc IERC721Holding
    function token() external view returns (address) {
        return address(this);
    }

    /// @inheritdoc IERC721Holding
    function minimumBalance() external pure returns (uint256) {
        return 1;
    }

    /// @inheritdoc IAccessPredicate
    function hasAccess(address user) public view returns (bool granted) {
        return balanceOf(user) >= 1;
    }

    /// @inheritdoc IAccessPredicate
    /// @dev `ok=true` always — the only failure mode is "user holds zero
    ///       passes" which is a denial, not a malfunction.
    function tryHasAccess(address user) external view returns (bool ok, bool granted) {
        return (true, hasAccess(user));
    }

    // -------------------------------------------------------------------
    //  Admin
    // -------------------------------------------------------------------

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function setTreasury(address payable newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        emit BaseURIUpdated(baseURI, newBaseURI);
        baseURI = newBaseURI;
    }

    function setRenderer(address newRenderer) external onlyOwner {
        emit RendererUpdated(address(renderer), newRenderer);
        renderer = IAxiomPassRenderer(newRenderer);
    }

    /// @notice Defensive sweep — mints forward to treasury synchronously, but
    ///         this catches stray ETH (e.g. direct sends with no calldata that
    ///         bypass `mint()`).
    function withdraw() external onlyOwner {
        uint256 bal = address(this).balance;
        if (bal == 0) return;
        Address.sendValue(treasury, bal);
    }

    // -------------------------------------------------------------------
    //  ERC165
    // -------------------------------------------------------------------

    /// @dev Interface IDs for ERC-8257 are taken from the draft EIP and may
    ///      shift before final. Update here if the spec changes.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Enumerable, IERC165)
        returns (bool)
    {
        return
            interfaceId == type(IAccessPredicate).interfaceId ||
            interfaceId == type(IERC721Holding).interfaceId ||
            interfaceId == 0xbdf9dc18 || // IAccessPredicate per EIP-8257 draft
            interfaceId == 0xbdf8c428 || // IERC721Holding per EIP-8257 draft
            super.supportsInterface(interfaceId);
    }
}
