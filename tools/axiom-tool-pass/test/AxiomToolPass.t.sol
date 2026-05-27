// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AxiomToolPass, IAccessPredicate, IERC721Holding} from "../contracts/AxiomToolPass.sol";

contract AxiomToolPassTest is Test {
    AxiomToolPass pass;
    address owner = address(0xA0);
    address payable treasury = payable(address(0xBEEF));
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    bytes32 seed = keccak256("axiom-tool-pass-v1");
    string baseURI = "https://clawbots.org/api/tool-pass/";

    function setUp() public {
        pass = new AxiomToolPass(owner, treasury, seed, baseURI);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    // ---------------------------------------------------------------- minting

    function test_mint_singlePass() public {
        vm.prank(alice);
        pass.mint{value: 0.005 ether}(1);

        assertEq(pass.balanceOf(alice), 1);
        assertEq(pass.ownerOf(1), alice);
        assertEq(pass.totalMinted(), 1);
        assertEq(treasury.balance, 0.005 ether);
    }

    function test_mint_multiplePasses() public {
        vm.prank(alice);
        pass.mint{value: 0.025 ether}(5);

        assertEq(pass.balanceOf(alice), 5);
        assertEq(pass.ownerOf(1), alice);
        assertEq(pass.ownerOf(5), alice);
        assertEq(treasury.balance, 0.025 ether);
    }

    function test_mint_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(pass));
        emit AxiomToolPass.Minted(alice, 3, 1, 0.015 ether);
        vm.prank(alice);
        pass.mint{value: 0.015 ether}(3);
    }

    function test_mint_forwardsToTreasury() public {
        uint256 startBal = treasury.balance;
        vm.prank(alice);
        pass.mint{value: 0.05 ether}(10);
        assertEq(treasury.balance - startBal, 0.05 ether);
        assertEq(address(pass).balance, 0); // nothing escrowed
    }

    function test_revert_zeroQuantity() public {
        vm.expectRevert(AxiomToolPass.InvalidQuantity.selector);
        vm.prank(alice);
        pass.mint{value: 0}(0);
    }

    function test_revert_incorrectPayment_underpay() public {
        vm.expectRevert(AxiomToolPass.IncorrectPayment.selector);
        vm.prank(alice);
        pass.mint{value: 0.004 ether}(1);
    }

    function test_revert_incorrectPayment_overpay() public {
        // strict equality — both directions reject. Prevents accidental tips.
        vm.expectRevert(AxiomToolPass.IncorrectPayment.selector);
        vm.prank(alice);
        pass.mint{value: 0.006 ether}(1);
    }

    function test_revert_walletLimit_exceedsInOneTx() public {
        vm.expectRevert(AxiomToolPass.WalletLimitExceeded.selector);
        vm.prank(alice);
        pass.mint{value: 0.055 ether}(11);
    }

    function test_revert_walletLimit_exceedsAcrossTxs() public {
        vm.prank(alice);
        pass.mint{value: 0.05 ether}(10);
        vm.expectRevert(AxiomToolPass.WalletLimitExceeded.selector);
        vm.prank(alice);
        pass.mint{value: 0.005 ether}(1);
    }

    function test_walletLimitIsPerWallet() public {
        // Alice maxes out — Bob is still free to mint his own 10.
        vm.prank(alice);
        pass.mint{value: 0.05 ether}(10);
        vm.prank(bob);
        pass.mint{value: 0.05 ether}(10);
        assertEq(pass.balanceOf(alice), 10);
        assertEq(pass.balanceOf(bob), 10);
    }

    function test_remainingForWallet_tracksCorrectly() public {
        assertEq(pass.remainingForWallet(alice), 10);
        vm.prank(alice);
        pass.mint{value: 0.015 ether}(3);
        assertEq(pass.remainingForWallet(alice), 7);
        vm.prank(alice);
        pass.mint{value: 0.035 ether}(7);
        assertEq(pass.remainingForWallet(alice), 0);
    }

    // ----------------------------------------------------------- supply cap

    function test_supplyCap_neverExceeds1000() public {
        // 100 wallets × 10 passes each = 1000. Cap exactly reached.
        for (uint256 i = 1; i <= 100; i++) {
            address w = address(uint160(0x1000 + i));
            vm.deal(w, 1 ether);
            vm.prank(w);
            pass.mint{value: 0.05 ether}(10);
        }
        assertEq(pass.totalMinted(), 1000);
        assertEq(pass.remainingSupply(), 0);

        // 1001st mint reverts.
        address overflower = address(uint160(0x9999));
        vm.deal(overflower, 1 ether);
        vm.expectRevert(AxiomToolPass.SupplyCapReached.selector);
        vm.prank(overflower);
        pass.mint{value: 0.005 ether}(1);
    }

    function test_supplyCap_partialLastBatch() public {
        // 99 wallets × 10 = 990 → next wallet can mint 10 more (total 1000) but
        // an 11-pass mint reverts. Test the boundary.
        for (uint256 i = 1; i <= 99; i++) {
            address w = address(uint160(0x1000 + i));
            vm.deal(w, 1 ether);
            vm.prank(w);
            pass.mint{value: 0.05 ether}(10);
        }
        assertEq(pass.remainingSupply(), 10);
        // Final wallet's per-wallet limit (10) lines up with remaining supply.
        address last = address(uint160(0x2000));
        vm.deal(last, 1 ether);
        vm.prank(last);
        pass.mint{value: 0.05 ether}(10);
        assertEq(pass.remainingSupply(), 0);
    }

    // -------------------------------------------------------------- pausing

    function test_pause_blocksMint() public {
        vm.prank(owner);
        pass.pause();
        vm.expectRevert();
        vm.prank(alice);
        pass.mint{value: 0.005 ether}(1);
    }

    function test_unpause_restoresMint() public {
        vm.prank(owner);
        pass.pause();
        vm.prank(owner);
        pass.unpause();
        vm.prank(alice);
        pass.mint{value: 0.005 ether}(1);
        assertEq(pass.balanceOf(alice), 1);
    }

    function test_revert_pauseFromNonOwner() public {
        vm.expectRevert();
        vm.prank(alice);
        pass.pause();
    }

    // -------------------------------------------------------------- metadata

    function test_tokenURI_fallsBackToBaseURI() public {
        vm.prank(alice);
        pass.mint{value: 0.005 ether}(1);
        assertEq(pass.tokenURI(1), "https://clawbots.org/api/tool-pass/1.json");
    }

    function test_tokenURI_revertsForUnminted() public {
        vm.expectRevert();
        pass.tokenURI(999);
    }

    function test_setRenderer_takesPrecedence() public {
        StubRenderer stub = new StubRenderer();
        vm.prank(owner);
        pass.setRenderer(address(stub));
        vm.prank(alice);
        pass.mint{value: 0.005 ether}(1);
        assertEq(pass.tokenURI(1), "stub://1");
    }

    function test_setBaseURI_updates() public {
        vm.prank(owner);
        pass.setBaseURI("https://new.example/");
        vm.prank(alice);
        pass.mint{value: 0.005 ether}(1);
        assertEq(pass.tokenURI(1), "https://new.example/1.json");
    }

    // ------------------------------------------------------------ ERC-8257

    function test_accessPredicate_grantsHolder() public {
        vm.prank(alice);
        pass.mint{value: 0.005 ether}(1);

        assertTrue(pass.hasAccess(alice));
        (bool ok, bool granted) = pass.tryHasAccess(alice);
        assertTrue(ok);
        assertTrue(granted);
    }

    function test_accessPredicate_deniesNonHolder() public {
        assertFalse(pass.hasAccess(alice));
        (bool ok, bool granted) = pass.tryHasAccess(alice);
        assertTrue(ok); // not a malfunction — denial is a normal answer
        assertFalse(granted);
    }

    function test_erc8257_views() public view {
        assertEq(pass.token(), address(pass));
        assertEq(pass.minimumBalance(), 1);
    }

    function test_supportsInterface_erc8257() public view {
        assertTrue(pass.supportsInterface(0xbdf9dc18)); // IAccessPredicate
        assertTrue(pass.supportsInterface(0xbdf8c428)); // IERC721Holding
        assertTrue(pass.supportsInterface(type(IAccessPredicate).interfaceId));
        assertTrue(pass.supportsInterface(type(IERC721Holding).interfaceId));
        // Sanity: still claims ERC-721 + Enumerable
        assertTrue(pass.supportsInterface(0x80ac58cd));
        assertTrue(pass.supportsInterface(0x780e9d63));
    }

    // ----------------------------------------------------------- treasury

    function test_setTreasury_updatesAndAffectsFutureMints() public {
        address payable newT = payable(address(0xCAFE));
        vm.prank(owner);
        pass.setTreasury(newT);
        vm.prank(alice);
        pass.mint{value: 0.005 ether}(1);
        assertEq(newT.balance, 0.005 ether);
        assertEq(treasury.balance, 0);
    }

    function test_revert_setTreasuryToZero() public {
        vm.expectRevert(AxiomToolPass.ZeroAddress.selector);
        vm.prank(owner);
        pass.setTreasury(payable(address(0)));
    }

    function test_revert_setTreasuryFromNonOwner() public {
        vm.expectRevert();
        vm.prank(alice);
        pass.setTreasury(payable(address(0xCAFE)));
    }

    // -------------------------------------------------------------- fuzzing

    function testFuzz_mint_validQuantity(uint256 qty) public {
        qty = bound(qty, 1, 10);
        uint256 cost = qty * 0.005 ether;
        vm.deal(alice, cost);
        vm.prank(alice);
        pass.mint{value: cost}(qty);
        assertEq(pass.balanceOf(alice), qty);
        assertEq(treasury.balance, cost);
    }

    function testFuzz_mint_wrongPaymentReverts(uint256 qty, uint256 payment) public {
        qty = bound(qty, 1, 10);
        uint256 correct = qty * 0.005 ether;
        vm.assume(payment != correct);
        payment = bound(payment, 0, 1 ether);
        vm.deal(alice, payment);
        vm.expectRevert(AxiomToolPass.IncorrectPayment.selector);
        vm.prank(alice);
        pass.mint{value: payment}(qty);
    }
}

contract StubRenderer {
    function tokenURI(uint256 tokenId) external pure returns (string memory) {
        return string.concat("stub://", _toString(tokenId));
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 t = v;
        uint256 d;
        while (t != 0) { d++; t /= 10; }
        bytes memory b = new bytes(d);
        while (v != 0) { b[--d] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }
}
